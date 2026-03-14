// ============================================================
// NapCatQQ 通道定义（严格遵循 OpenClaw ChannelPlugin 规范）
// ============================================================

import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelSecurityAdapter,
  ChannelSecurityDmPolicy,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelPairingAdapter,
  ChannelGroupAdapter,
  ChannelMessagingAdapter,
  ChannelThreadingAdapter,
  ChannelStatusAdapter,
  ChannelStatusIssue,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";
import type { NapCatAccountConfig } from "./types.js";
import { sendMessage, getLoginInfo, uploadPrivateFile, uploadGroupFile, markPrivateMsgAsRead, markGroupMsgAsRead, getGroupMemberInfo } from "./outbound.js";
import { getClient, requireClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, listAccountIds, resolveAccount, config } from "./config.js";
import { configSchema } from "./config-schema.js";
import { onboarding, setup } from "./onboarding.js";
import { gateway } from "./gateway.js";

// ---------- 通道元信息 ----------

const meta: ChannelMeta = {
  id: CHANNEL_ID,
  label: "QQ (NapCat)",
  selectionLabel: "QQ via NapCatQQ (OneBot v11 WebSocket)",
  docsPath: "/channels/napcatqq",
  docsLabel: "napcatqq",
  blurb: "Connect to QQ using NapCatQQ WebSocket (supports HTTPS reverse proxy).",
  order: 80,
  aliases: ["qq", "napcat"],
};

// ---------- 能力声明 ----------

const capabilities: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  reply: true,
  media: true,
  reactions: true,    // v0.5: set_msg_emoji_like
  unsend: false,      // v0.6: disabled, Agent context doesn't track outgoing msgIds well, better suited for group admin bots
  // QQ 协议不支持以下能力
  edit: false,
  polls: false,
  threads: false,
  effects: false,
  groupManagement: false,
  nativeCommands: false,
  blockStreaming: false,
};

// ---------- 安全/DM 策略（配对认证） ----------

const security: ChannelSecurityAdapter<NapCatAccountConfig> = {
  resolveDmPolicy: ({ cfg, account }): ChannelSecurityDmPolicy => {
    const policy = account.dm?.policy ?? "pairing";
    const allowFrom = [
      ...(account.dm?.allowFrom ?? []),
      ...(account.allowFrom ?? []),
    ];
    return {
      policy,
      allowFrom,
      policyPath: `channels.napcatqq.accounts.${account.accountId}.dm.policy`,
      allowFromPath: `channels.napcatqq.accounts.${account.accountId}.dm.allowFrom`,
      approveHint: formatPairingApproveHint(CHANNEL_ID),
    };
  },
  collectWarnings: ({ account }) => {
    const warnings: string[] = [];
    const policy = account.dm?.policy ?? "pairing";
    const allowFrom = [
      ...(account.dm?.allowFrom ?? []),
      ...(account.allowFrom ?? []),
    ];
    if (policy === "open" && (!allowFrom || allowFrom.length === 0)) {
      warnings.push(
        `- NapCatQQ (${account.accountId}): dm.policy="open" with no allowFrom — any QQ user can trigger the bot. Set dm.policy="pairing" or configure allowFrom.`,
      );
    }
    if (allowFrom?.some((entry) => String(entry) === "*")) {
      warnings.push(
        `- NapCatQQ (${account.accountId}): allowFrom contains "*" — any QQ user can trigger the bot without pairing.`,
      );
    }
    const gp = account.groupPolicy ?? "disabled";
    if (gp === "open") {
      warnings.push(
        `- NapCatQQ (${account.accountId}): groupPolicy="open" — any group can trigger the bot (mention-gated). Set groupPolicy="allowlist" + groupAllowFrom to restrict.`,
      );
    }
    return warnings;
  },
};

// ---------- 配对适配器 ----------

const pairing: ChannelPairingAdapter = {
  idLabel: "QQ",
  normalizeAllowEntry: (entry) => entry.trim(),
  notifyApproval: async ({ cfg, id, runtime }) => {
    const accountIds = listAccountIds(cfg);
    for (const accId of accountIds) {
      const client = getClient(accId);
      if (client) {
        await sendMessage(client, {
          chatType: "direct",
          userId: id,
          text: PAIRING_APPROVED_MESSAGE,
        });
        return;
      }
    }
  },
};

// ---------- 群组适配器 ----------

const groups: ChannelGroupAdapter = {
  resolveRequireMention: ({ cfg, groupId, accountId }) => {
    const account = resolveAccount(cfg, accountId);
    return account.requireMention;
  },
  resolveToolPolicy: ({ cfg, groupId, accountId }) => {
    return undefined;
  },
};

// ---------- 目录适配器（联系人/群列表） ----------

const directory = {
  self: async () => null,
  listPeers: async ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
    const accId = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
    const client = getClient(accId);
    if (!client) return [];
    try {
      const resp = await client.callApi("get_friend_list", {}, 10000);
      if (resp.status !== "ok" || !Array.isArray(resp.data)) return [];
      return (resp.data as Array<{ user_id: number; nickname: string; remark?: string }>).map((f) => ({
        kind: "user" as const,
        id: String(f.user_id),
        name: f.remark || f.nickname,
        handle: String(f.user_id),
      }));
    } catch { return []; }
  },
  listGroups: async ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
    const accId = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
    const client = getClient(accId);
    if (!client) return [];
    try {
      const resp = await client.callApi("get_group_list", {}, 10000);
      if (resp.status !== "ok" || !Array.isArray(resp.data)) return [];
      return (resp.data as Array<{ group_id: number; group_name: string }>).map((g) => ({
        kind: "group" as const,
        id: `g${g.group_id}`,
        name: g.group_name,
      }));
    } catch { return []; }
  },
};

// ---------- 消息适配器（目标解析） ----------

const messaging: ChannelMessagingAdapter = {
  normalizeTarget: (raw: string) => {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;                 // QQ 号
    if (/^g\d+$/i.test(trimmed)) return trimmed.toLowerCase(); // 群号
    return undefined;
  },
  targetResolver: {
    looksLikeId: (raw: string, normalized?: string) => {
      const trimmed = (normalized ?? raw).trim();
      return /^\d+$/.test(trimmed) || /^g\d+$/i.test(trimmed);
    },
    hint: "QQ号 (如 12345678) 或群号 (如 g87654321)",
  },
  formatTargetDisplay: ({ target, display, kind }) => {
    if (display) return display;
    if (target.startsWith("g")) return `群${target.slice(1)}`;
    return `QQ${target}`;
  },
};

// ---------- 出站适配器 ----------

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  chunker: (text, limit) => getNapCatRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown" as const,

  sendText: async (ctx: ChannelOutboundContext) => {
    const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
    const log = getNapCatRuntime().logging.getChildLogger({ channel: "napcatqq-outbound" });
    log.info(`[napcatqq] outbound.sendText called: to=${ctx.to} accountId=${accountId} textLen=${ctx.text?.length}`);

    const client = requireClient(accountId);

    const to = ctx.to.replace(/^napcatqq:/i, "");
    const normalizeTarget = messaging.normalizeTarget;
    const normalizedTo = normalizeTarget ? normalizeTarget(to) : undefined;
    if (!normalizedTo) {
      throw new Error(`invalid target: ${ctx.to}`);
    }
    const isGroup = normalizedTo.startsWith("g");
    const targetId = isGroup ? normalizedTo.slice(1) : normalizedTo;

    const result = await sendMessage(client, {
      chatType: isGroup ? "group" : "direct",
      userId: isGroup ? undefined : targetId,
      groupId: isGroup ? targetId : undefined,
      text: ctx.text,
      replyToMessageId: ctx.replyToId ?? undefined,
    });

    return {
      channel: CHANNEL_ID,
      messageId: result.messageId ? String(result.messageId) : "",
    };
  },

  sendMedia: async (ctx: ChannelOutboundContext) => {
    const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
    const log = getNapCatRuntime().logging.getChildLogger({ channel: "napcatqq-outbound" });
    log.info(`[napcatqq] outbound.sendMedia called: to=${ctx.to} accountId=${accountId} mediaUrl=${ctx.mediaUrl}`);

    const client = requireClient(accountId);

    const to = ctx.to.replace(/^napcatqq:/i, "");
    const normalizeTarget = messaging.normalizeTarget;
    const normalizedTo = normalizeTarget ? normalizeTarget(to) : undefined;
    if (!normalizedTo) {
      throw new Error(`invalid target: ${ctx.to}`);
    }
    const isGroup = normalizedTo.startsWith("g");
    const targetId = isGroup ? normalizedTo.slice(1) : normalizedTo;

    // 检测媒体类型
    const mediaUrl = ctx.mediaUrl ?? "";
    const contentType = (ctx as any).mediaContentType ?? "";
    const isAudio = contentType.startsWith("audio/") ||
      /\.(mp3|ogg|wav|amr|silk|m4a|flac|aac)$/i.test(mediaUrl);
    const isVideo = contentType.startsWith("video/") ||
      /\.(mp4|avi|mkv|mov|webm)$/i.test(mediaUrl);

    const result = await sendMessage(client, {
      chatType: isGroup ? "group" : "direct",
      userId: isGroup ? undefined : targetId,
      groupId: isGroup ? targetId : undefined,
      text: ctx.text || undefined,
      imageUrl: (!isAudio && !isVideo && mediaUrl) ? mediaUrl : undefined,
      voiceUrl: isAudio ? mediaUrl : undefined,
      videoUrl: isVideo ? mediaUrl : undefined,
      replyToMessageId: ctx.replyToId ?? undefined,
    });

    // 发送额外的图片（mediaUrls 数组中的后续图片）
    const extraUrls = ((ctx as any).mediaUrls ?? []).slice(1) as string[];
    for (const extraUrl of extraUrls) {
      try {
        await sendMessage(client, {
          chatType: isGroup ? "group" : "direct",
          userId: isGroup ? undefined : targetId,
          groupId: isGroup ? targetId : undefined,
          imageUrl: extraUrl,
        });
      } catch {
        log.warn(`[napcatqq] failed to send extra image: ${extraUrl}`);
      }
    }

    return {
      channel: CHANNEL_ID,
      messageId: result.messageId ? String(result.messageId) : "",
    };
  },
};

// ---------- Threading 适配器 ----------

const threading: ChannelThreadingAdapter = {
  resolveReplyToMode: ({ cfg, accountId, chatType }) => "off",
  allowExplicitReplyTagsWhenOff: true,
};

// ---------- 状态适配器 ----------

const status: ChannelStatusAdapter<NapCatAccountConfig> = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },
  buildAccountSnapshot: ({ account, runtime }) => ({
    accountId: account.accountId,
    enabled: account.enabled,
    configured: !!account.wsUrl,
    running: runtime?.running ?? false,
    connected: runtime?.connected ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    bot: runtime?.bot ?? undefined,
  }),
  buildChannelSummary: ({ snapshot }) => {
    const bot = snapshot.bot as { userId?: string; nickname?: string } | undefined;
    const botLabel = bot?.nickname ? `${bot.nickname}` : bot?.userId ? `QQ ${bot.userId}` : "";
    const status = snapshot.connected ? "connected" : snapshot.running ? "connecting" : "stopped";
    return {
      status,
      bot: botLabel || undefined,
      configured: snapshot.configured ?? false,
      connected: snapshot.connected ?? false,
    };
  },
  collectStatusIssues: (accounts) => {
    const issues: ChannelStatusIssue[] = [];
    for (const a of accounts) {
      if (!a.configured) {
        issues.push({
          channel: CHANNEL_ID,
          accountId: a.accountId,
          kind: "config",
          message: "NapCat WebSocket URL not configured",
          fix: `Set channels.napcatqq.accounts.${a.accountId}.wsUrl`,
        });
      }
    }
    return issues;
  },
  probeAccount: async ({ account }) => {
    const client = getClient(account.accountId);
    if (!client) return { ok: false, error: "not connected" };
    const info = await getLoginInfo(client);
    if (!info) return { ok: false, error: "get_login_info failed" };
    return { ok: true, bot: { userId: info.userId, nickname: info.nickname } };
  },
};

// ---------- 消息动作适配器（撤回、表情回应等） ----------

const actions: ChannelMessageActionAdapter = {
  supportsAction: ({ action }) => {
    return ["react", "send", "sendAttachment", "read", "reply", "member-info"].includes(action);
  },
  listActions: () => ["react", "send", "sendAttachment", "read", "reply", "member-info"],
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
    const client = getClient(accountId);
    if (!client) {
      return {
        content: [{ type: "text" as const, text: "Not connected" }],
        details: { ok: false },
      };
    }

    const params = ctx.params;

    // 表情回应
    if (ctx.action === "react") {
      const messageId = params.message_id ?? params.messageId;
      const emoji = params.emoji_id ?? params.emoji ?? "76"; // 默认 👍 (QQ emoji ID=76)
      if (!messageId) {
        return {
          content: [{ type: "text" as const, text: "message_id required" }],
          details: { ok: false },
        };
      }
      if (!/^\d+$/.test(String(emoji))) {
        return {
          content: [{ type: "text" as const, text: "emoji / emoji_id must be a QQ emoji ID (numeric)" }],
          details: { ok: false },
        };
      }
      const { setMsgEmojiLike } = await import("./outbound.js");
      const ok = await setMsgEmojiLike(client, String(messageId), String(emoji));
      return {
        content: [{ type: "text" as const, text: ok ? `已回应表情 ${emoji}` : "表情回应失败" }],
        details: { ok },
      };
    }

    // 发送文件
    if (ctx.action === "sendAttachment") {
      const target = String(params.target ?? params.to ?? "");
      const buffer = params.buffer as string | undefined;
      const filename = String(params.filename ?? params.name ?? "file");

      if (!target) {
        return {
          content: [{ type: "text" as const, text: "target required" }],
          details: { ok: false },
        };
      }
      if (!buffer) {
        return {
          content: [{ type: "text" as const, text: "buffer (base64 file data) required" }],
          details: { ok: false },
        };
      }
      const cleanedBuffer = buffer.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/=]+$/.test(cleanedBuffer)) {
        return {
          content: [{ type: "text" as const, text: "buffer must be valid base64" }],
          details: { ok: false },
        };
      }
      try {
        const decoded = Buffer.from(cleanedBuffer, "base64");
        if (decoded.length === 0 && cleanedBuffer.length > 0) {
          throw new Error("empty decode result");
        }
        if (decoded.toString("base64").replace(/=+$/g, "") !== cleanedBuffer.replace(/=+$/g, "")) {
          throw new Error("base64 roundtrip mismatch");
        }
      } catch {
        return {
          content: [{ type: "text" as const, text: "buffer must be valid base64" }],
          details: { ok: false },
        };
      }
      const estimatedBytes = Math.floor(cleanedBuffer.length * 3 / 4);
      if (estimatedBytes > 25 * 1024 * 1024) {
        return {
          content: [{ type: "text" as const, text: "attachment too large (>25MB)" }],
          details: { ok: false, estimatedBytes },
        };
      }

      const to = target.replace(/^napcatqq:/i, "");
      const isGroup = to.startsWith("g");
      const targetId = isGroup ? to.slice(1) : to;

      // 直接用 base64:// 前缀传给 NapCat，无需临时文件（支持跨服务器）
      const fileData = `base64://${buffer}`;
      let ok: boolean;
      if (isGroup) {
        ok = await uploadGroupFile(client, targetId, fileData, filename);
      } else {
        ok = await uploadPrivateFile(client, targetId, fileData, filename);
      }

      // 同时发送 caption（如果有的话）
      const caption = String(params.caption ?? params.message ?? "");
      let captionOk = true;
      let captionError = "";
      if (ok && caption) {
        try {
          const captionResult = await sendMessage(client, {
            chatType: isGroup ? "group" : "direct",
            userId: isGroup ? undefined : targetId,
            groupId: isGroup ? targetId : undefined,
            text: caption,
          });
          captionOk = captionResult.ok;
          if (!captionResult.ok) {
            captionError = String(captionResult.error ?? "caption send failed");
          }
        } catch (err) {
          captionOk = false;
          captionError = String(err);
        }
      }

      return {
        content: [{ type: "text" as const, text: ok ? (caption && !captionOk ? `文件 ${filename} 已发送（caption 发送失败）` : `文件 ${filename} 已发送`) : "文件发送失败" }],
        details: { ok, filename, captionOk, ...(captionError ? { captionError } : {}) },
      };
    }

    // 标记已读
    if (ctx.action === "read") {
      const target = String(params.target ?? params.to ?? "");
      if (!target) {
        return {
          content: [{ type: "text" as const, text: "target required" }],
          details: { ok: false },
        };
      }
      const to = target.replace(/^napcatqq:/i, "");
      const normalizeTarget = messaging.normalizeTarget;
      const normalizedTo = normalizeTarget ? normalizeTarget(to) : undefined;
      if (!normalizedTo) {
        return {
          content: [{ type: "text" as const, text: "invalid target" }],
          details: { ok: false },
        };
      }
      const isGroup = normalizedTo.startsWith("g");
      const targetId = isGroup ? normalizedTo.slice(1) : normalizedTo;
      const ok = isGroup
        ? await markGroupMsgAsRead(client, targetId)
        : await markPrivateMsgAsRead(client, targetId);
      return {
        content: [{ type: "text" as const, text: ok ? "已标记已读" : "标记已读失败" }],
        details: { ok },
      };
    }

    // 发送消息（send action — Agent 主动发消息到指定目标）
    if (ctx.action === "send") {
      const target = String(params.target ?? params.to ?? "");
      const text = String(params.message ?? params.text ?? "");
      if (!target || !text) {
        return {
          content: [{ type: "text" as const, text: "target and message required" }],
          details: { ok: false },
        };
      }
      const to = target.replace(/^napcatqq:/i, "");
      const normalizeTarget = messaging.normalizeTarget;
      const normalizedTo = normalizeTarget ? normalizeTarget(to) : undefined;
      if (!normalizedTo) {
        return {
          content: [{ type: "text" as const, text: "invalid target" }],
          details: { ok: false },
        };
      }
      const isGroup = normalizedTo.startsWith("g");
      const targetId = isGroup ? normalizedTo.slice(1) : normalizedTo;
      const result = await sendMessage(client, {
        chatType: isGroup ? "group" : "direct",
        userId: isGroup ? undefined : targetId,
        groupId: isGroup ? targetId : undefined,
        text,
      });
      return {
        content: [{ type: "text" as const, text: result.ok ? "已发送" : `发送失败: ${result.error}` }],
        details: { ok: result.ok, messageId: result.messageId },
      };
    }

    // 引用回复
    if (ctx.action === "reply") {
      const target = String(params.target ?? params.to ?? "");
      const replyToId = String(params.replyTo ?? params.message_id ?? params.messageId ?? "");
      const text = String(params.message ?? params.text ?? "");
      if (!target || !text || !replyToId) {
        return {
          content: [{ type: "text" as const, text: "target, message, and replyTo/message_id required" }],
          details: { ok: false },
        };
      }
      const to = target.replace(/^napcatqq:/i, "");
      const normalizeTarget = messaging.normalizeTarget;
      const normalizedTo = normalizeTarget ? normalizeTarget(to) : undefined;
      if (!normalizedTo) {
        return {
          content: [{ type: "text" as const, text: "invalid target" }],
          details: { ok: false },
        };
      }
      const isGroup = normalizedTo.startsWith("g");
      const targetId = isGroup ? normalizedTo.slice(1) : normalizedTo;
      const result = await sendMessage(client, {
        chatType: isGroup ? "group" : "direct",
        userId: isGroup ? undefined : targetId,
        groupId: isGroup ? targetId : undefined,
        text,
        replyToMessageId: replyToId || undefined,
      });
      return {
        content: [{ type: "text" as const, text: result.ok ? "已回复" : `回复失败: ${result.error}` }],
        details: { ok: result.ok, messageId: result.messageId },
      };
    }

    // 获取群成员信息
    if (ctx.action === "member-info") {
      const rawGroupId = String(params.groupId ?? params.group_id ?? "");
      const groupId = rawGroupId.replace(/^g/i, "");
      const userId = String(params.userId ?? params.user_id ?? params.target ?? "");
      if (!groupId || !userId) {
        return {
          content: [{ type: "text" as const, text: "groupId and userId required" }],
          details: { ok: false },
        };
      }
      if (!/^\d+$/.test(groupId)) {
        return {
          content: [{ type: "text" as const, text: "groupId must be numeric or g-prefixed numeric" }],
          details: { ok: false },
        };
      }
      const info = await getGroupMemberInfo(client, groupId, userId);
      if (!info) {
        return {
          content: [{ type: "text" as const, text: "获取群成员信息失败" }],
          details: { ok: false },
        };
      }
      return {
        content: [{ type: "text" as const, text: `${info.card || info.nickname} (${info.user_id})\n角色: ${info.role}\n头衔: ${info.title || "无"}\n等级: ${info.level}` }],
        details: { ok: true, ...info },
      };
    }

    return {
      content: [{ type: "text" as const, text: `Unsupported action: ${ctx.action}` }],
      details: { ok: false },
    };
  },
};

// ---------- 导出通道插件 ----------

export const napcatChannel: ChannelPlugin<NapCatAccountConfig> = {
  id: CHANNEL_ID,
  meta,
  capabilities,
  configSchema,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  agentPrompt: {
    messageToolHints: () => [
      "- QQ targeting: use QQ号 (e.g. `12345678`) for DM, or `g群号` (e.g. `g87654321`) for group messages.",
      "- QQ does not support message editing, inline buttons, or polls.",
    ],
  },
  config,
  setup,
  onboarding,
  security,
  pairing,
  groups,
  directory,
  messaging,
  threading,
  outbound,
  actions,
  status,
  gateway,
};
