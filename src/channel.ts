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
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";
import type { NapCatAccountConfig } from "./types.js";
import { sendMessage, getLoginInfo } from "./outbound.js";
import { getClient, requireClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, listAccountIds, resolveAccount, getAccountsRecord, config } from "./config.js";
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
  // QQ 协议不支持以下能力
  reactions: false,
  edit: false,
  unsend: false,
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
    const allowFrom = account.dm?.allowFrom ?? account.allowFrom ?? [];
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
    const allowFrom = account.dm?.allowFrom ?? account.allowFrom ?? [];
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
    const isGroup = to.startsWith("g");
    const targetId = isGroup ? to.slice(1) : to;

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
    const isGroup = to.startsWith("g");
    const targetId = isGroup ? to.slice(1) : to;

    const result = await sendMessage(client, {
      chatType: isGroup ? "group" : "direct",
      userId: isGroup ? undefined : targetId,
      groupId: isGroup ? targetId : undefined,
      text: ctx.text || undefined,
      imageUrl: ctx.mediaUrl,
      replyToMessageId: ctx.replyToId ?? undefined,
    });

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
  status,
  gateway,
};
