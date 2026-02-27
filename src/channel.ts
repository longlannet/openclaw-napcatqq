// ============================================================
// NapCatQQ 通道定义（严格遵循 OpenClaw ChannelPlugin 规范）
// ============================================================

import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelConfigSchema,
  ChannelSecurityAdapter,
  ChannelSecurityDmPolicy,
  ChannelOutboundAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelOutboundContext,
  ChannelPairingAdapter,
  ChannelGroupAdapter,
  ChannelMessagingAdapter,
  ChannelOnboardingAdapter,
  ChannelSetupAdapter,
  ChannelThreadingAdapter,
  ChannelStatusAdapter,
  ChannelStatusIssue,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  createTypingCallbacks,
  createReplyPrefixOptions,
  logTypingFailure,
  logInboundDrop,
  resolveControlCommandGate,
  resolveDmGroupAccessWithLists,
  readStoreAllowFromForDmPolicy,
  createScopedPairingAccess,
  resolveAllowlistMatchSimple,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  evictOldHistoryKeys,
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveMentionGating,
  type HistoryEntry,
} from "openclaw/plugin-sdk";

// 注意 SDK 函数签名（对照 .d.ts 确认）：
// setAccountEnabledInConfigSection({ cfg, sectionKey, accountId, enabled, allowTopLevel? })
// deleteAccountFromConfigSection({ cfg, sectionKey, accountId, clearBaseFields? })
// formatPairingApproveHint(channelId)  ← 只接受一个参数
import type { NapCatAccountConfig } from "./types.js";
import type { OneBotMessageEvent } from "./types.js";
import { NapCatWsClient } from "./ws-client.js";
import { normalizeInbound, isMentioningBot, stripBotMention, type NormalizedInbound } from "./inbound.js";
import { sendMessage, getMessage, getLoginInfo } from "./outbound.js";
import { registerClient, unregisterClient, getClient, requireClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------- 配置读取 ----------

const CHANNEL_ID = "napcatqq" as const;

function getAccountsRecord(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg as any).channels?.napcatqq?.accounts ?? {};
}

function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(getAccountsRecord(cfg));
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): NapCatAccountConfig {
  const id = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
  const accounts = getAccountsRecord(cfg);
  const raw = (accounts[id] ?? {}) as Record<string, unknown>;
  return {
    accountId: id,
    enabled: raw.enabled !== false,
    wsUrl: (raw.wsUrl as string) ?? "",
    accessToken: raw.accessToken as string | undefined,
    selfId: raw.selfId as string | undefined,
    requireMention: raw.requireMention !== false,      // 默认群聊需要 @
    commandPrefix: (raw.commandPrefix as string) ?? "/",
    allowFrom: raw.allowFrom as Array<string | number> | undefined,
    groupPolicy: raw.groupPolicy as NapCatAccountConfig["groupPolicy"],
    groupAllowFrom: raw.groupAllowFrom as Array<string | number> | undefined,
    historyLimit: raw.historyLimit as number | undefined,
    dm: raw.dm as NapCatAccountConfig["dm"],
  };
}

function isAccountConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const account = resolveAccount(cfg, accountId);
  return !!account.wsUrl;
}

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

// ---------- 通道 configSchema（控制面板渲染用） ----------

const configSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    properties: {
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            wsUrl: { type: "string", format: "uri" },
            accessToken: { type: "string" },
            selfId: { type: "string" },
            requireMention: { type: "boolean" },
            commandPrefix: { type: "string" },
            defaultTo: { type: "string" },
            groupPolicy: {
              type: "string",
              enum: ["disabled", "open", "allowlist", "pairing"],
            },
            groupAllowFrom: {
              type: "array",
              items: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
            historyLimit: { type: "number" },
            allowFrom: {
              type: "array",
              items: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
            dm: {
              type: "object",
              properties: {
                policy: {
                  type: "string",
                  enum: ["pairing", "open", "closed"],
                },
                allowFrom: {
                  type: "array",
                  items: { oneOf: [{ type: "string" }, { type: "number" }] },
                },
              },
            },
          },
          required: ["wsUrl"],
        },
      },
    },
  },
  uiHints: {
    "accounts.*.wsUrl": {
      label: "NapCat WebSocket URL",
      placeholder: "wss://ncqw.example.com",
    },
    "accounts.*.accessToken": {
      label: "Access Token",
      sensitive: true,
    },
    "accounts.*.selfId": {
      label: "机器人 QQ 号",
      help: "连接成功后自动获取，也可手动填写",
    },
    "accounts.*.requireMention": {
      label: "群聊需要 @ 才响应",
    },
    "accounts.*.commandPrefix": {
      label: "命令前缀",
      placeholder: "/",
    },
    "accounts.*.defaultTo": {
      label: "默认发送目标",
      help: "QQ号 或 g群号（message 工具省略 target 时使用）",
    },
    "accounts.*.groupPolicy": {
      label: "群聊策略",
      help: "disabled = 不响应群聊 | open = 响应所有群（需 @）| allowlist = 仅白名单群 | pairing = 新群需审批",
    },
    "accounts.*.groupAllowFrom": {
      label: "群聊白名单",
      help: "groupPolicy=allowlist 或 pairing 时，已批准的群号列表（格式: g群号）",
    },
    "accounts.*.historyLimit": {
      label: "群聊历史消息上限",
      help: "群聊中被忽略的消息缓存条数（用于上下文），默认 50",
    },
    "accounts.*.dm.policy": {
      label: "私聊策略",
      help: "pairing = 需配对授权 | open = 全部放行 | closed = 全部拒绝",
    },
  },
};

// ---------- 配置适配器 ----------

const config: ChannelConfigAdapter<NapCatAccountConfig> = {
  listAccountIds,
  resolveAccount,
  defaultAccountId: (cfg) => {
    const ids = listAccountIds(cfg);
    return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0] ?? DEFAULT_ACCOUNT_ID;
  },
  setAccountEnabled: ({ cfg, accountId, enabled }) =>
    setAccountEnabledInConfigSection({
      cfg,
      sectionKey: CHANNEL_ID,
      accountId,
      enabled,
    }),
  deleteAccount: ({ cfg, accountId }) =>
    deleteAccountFromConfigSection({
      cfg,
      sectionKey: CHANNEL_ID,
      accountId,
    }),
  isEnabled: (account, cfg) => account.enabled,
  isConfigured: (account, cfg) => !!account.wsUrl,
  unconfiguredReason: (account, cfg) =>
    !account.wsUrl ? "Missing wsUrl (NapCat WebSocket address)" : "",
  resolveAllowFrom: ({ cfg, accountId }) => {
    const account = resolveAccount(cfg, accountId);
    return account.dm?.allowFrom ?? account.allowFrom;
  },
  formatAllowFrom: ({ allowFrom }) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean),
  describeAccount: (account, cfg) => ({
    accountId: account.accountId,
    enabled: account.enabled,
    configured: !!account.wsUrl,
  }),
  resolveDefaultTo: ({ cfg, accountId }) => {
    const raw = (getAccountsRecord(cfg)[normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID)] ?? {}) as Record<string, unknown>;
    const val = raw.defaultTo;
    return val != null ? String(val) : undefined;
  },
};

// ---------- Onboarding 适配器（openclaw channels login 向导） ----------

const onboarding: ChannelOnboardingAdapter = {
  channel: CHANNEL_ID,

  getStatus: async (ctx) => {
    const { cfg } = ctx;
    const ids = listAccountIds(cfg);
    const configured = ids.some((id) => isAccountConfigured(cfg, id));
    const statusLines: string[] = [];

    if (ids.length === 0) {
      statusLines.push("No accounts configured.");
    } else {
      for (const id of ids) {
        const account = resolveAccount(cfg, id);
        const state = account.wsUrl
          ? `✅ ${id}: ${account.wsUrl}`
          : `❌ ${id}: wsUrl not set`;
        statusLines.push(state);
      }
    }

    return {
      channel: CHANNEL_ID,
      configured,
      statusLines,
      selectionHint: "Requires a NapCatQQ instance with WebSocket enabled.",
    };
  },

  configure: async (ctx) => {
    const { cfg, prompter, accountOverrides } = ctx;
    const accountId = accountOverrides[CHANNEL_ID] ?? DEFAULT_ACCOUNT_ID;

    // 1. 提示输入 WebSocket URL
    const wsUrl = await prompter.text({
      message: "NapCat WebSocket URL:",
      initialValue: "wss://",
      placeholder: "wss://ncqw.example.com",
      validate: (v: string) => {
        if (!v.startsWith("ws://") && !v.startsWith("wss://")) {
          return "Must start with ws:// or wss://";
        }
        return undefined;
      },
    });

    // 2. 提示输入 Access Token（text 代替 password，SDK 没有 password 方法）
    const accessToken = await prompter.text({
      message: "Access Token (leave empty if none):",
      placeholder: "your-onebot-access-token",
    });

    // 3. 写入配置
    let nextCfg = { ...cfg } as any;
    nextCfg.channels ??= {};
    nextCfg.channels.napcatqq ??= {};
    nextCfg.channels.napcatqq.accounts ??= {};
    nextCfg.channels.napcatqq.accounts[accountId] = {
      enabled: true,
      wsUrl,
      ...(accessToken ? { accessToken } : {}),
      dm: {},
    };

    // 4. 提示 DM 访问策略
    const dmPolicy = await prompter.select<string>({
      message: "DM access policy:",
      options: [
        { value: "pairing", label: "Pairing (require approval)" },
        { value: "open", label: "Open (allow all)" },
        { value: "closed", label: "Closed (deny all)" },
      ],
      initialValue: "pairing",
    });
    nextCfg.channels.napcatqq.accounts[accountId].dm.policy = dmPolicy;

    // 5. 管理员 QQ 号（必填，用于私聊配对审批和群 pairing 通知）
    const ownerQQ = await prompter.text({
      message: "管理员 QQ 号 (your QQ number, required for approvals):",
      placeholder: "123456789",
      validate: (v: string) => {
        if (!v.trim() || !/^\d+$/.test(v.trim())) {
          return "Please enter a valid QQ number (digits only)";
        }
        return undefined;
      },
    });
    nextCfg.channels.napcatqq.accounts[accountId].allowFrom = [ownerQQ.trim()];

    // 6. 群聊策略
    const groupPolicy = await prompter.select<string>({
      message: "Group chat policy:",
      options: [
        { value: "disabled", label: "Disabled (ignore all groups)" },
        { value: "pairing", label: "Pairing (new groups need approval)" },
        { value: "open", label: "Open (respond in all groups, mention required)" },
        { value: "allowlist", label: "Allowlist (only whitelisted groups)" },
      ],
      initialValue: "pairing",
    });
    nextCfg.channels.napcatqq.accounts[accountId].groupPolicy = groupPolicy;

    // 7. 群聊是否需要 @ 才响应
    if (groupPolicy !== "disabled") {
      const requireMention = await prompter.select<string>({
        message: "群聊需要 @机器人 才响应？",
        options: [
          { value: "true", label: "是（推荐，适合大群）" },
          { value: "false", label: "否（响应所有消息，适合小群/专用群）" },
        ],
        initialValue: "true",
      });
      nextCfg.channels.napcatqq.accounts[accountId].requireMention = requireMention === "true";
    }

    return { cfg: nextCfg as OpenClawConfig, accountId };
  },

  disable: (cfg: OpenClawConfig) => {
    const nextCfg = { ...cfg } as any;
    const ids = listAccountIds(cfg);
    for (const id of ids) {
      if (nextCfg.channels?.napcatqq?.accounts?.[id]) {
        nextCfg.channels.napcatqq.accounts[id].enabled = false;
      }
    }
    return nextCfg as OpenClawConfig;
  },
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
    // 尝试找到一个可用的客户端发送配对成功通知
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
    // 默认群聊不限制工具
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
    // 支持纯数字 QQ 号，或 "g12345" 格式群号
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
  textChunkLimit: 4000, // QQ 单条消息长度限制
  chunker: (text, limit) => getNapCatRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown" as const,

  sendText: async (ctx: ChannelOutboundContext) => {
    const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
    const log = getNapCatRuntime().logging.getChildLogger({ channel: "napcatqq-outbound" });
    log.info(`[napcatqq] outbound.sendText called: to=${ctx.to} accountId=${accountId} textLen=${ctx.text?.length}`);

    const client = requireClient(accountId);

    // 解析目标：可能带 "napcatqq:" 前缀，也可能是纯 "g12345" 或 "12345"
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
    connected: runtime?.connected ?? false,
    bot: runtime?.bot ?? undefined,
    ...runtime,
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
      if (a.enabled && a.configured && !a.connected && !a.running) {
        issues.push({
          channel: CHANNEL_ID,
          accountId: a.accountId,
          kind: "runtime",
          message: "Account enabled but not running",
          fix: `Check gateway logs or restart: openclaw gateway restart`,
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

// ---------- Setup 适配器（openclaw channels add 命令） ----------

const setup: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => normalizeAccountId(accountId),
  validateInput: ({ cfg, accountId, input }) => {
    if (!input.url) {
      return "NapCatQQ requires a WebSocket URL (--url wss://...).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const nextCfg = { ...cfg } as any;
    nextCfg.channels ??= {};
    nextCfg.channels.napcatqq ??= {};
    nextCfg.channels.napcatqq.accounts ??= {};
    nextCfg.channels.napcatqq.accounts[accountId] = {
      ...nextCfg.channels.napcatqq.accounts[accountId],
      enabled: true,
      wsUrl: input.url ?? "",
      ...(input.token ? { accessToken: input.token } : {}),
    };
    return nextCfg as OpenClawConfig;
  },
};

// ---------- Threading 适配器 ----------

const threading: ChannelThreadingAdapter = {
  resolveReplyToMode: ({ cfg, accountId, chatType }) => "off", // QQ 不支持线程，引用回复在 outbound 层处理
  allowExplicitReplyTagsWhenOff: true, // 允许 [[reply_to:xxx]] 标签保留 replyToId
};

// ---------- 网关适配器（WS 长连接管理） ----------

const gateway: ChannelGatewayAdapter<NapCatAccountConfig> = {
  startAccount: async (ctx: ChannelGatewayContext<NapCatAccountConfig>) => {
    const { cfg, accountId, account, runtime, log, abortSignal, getStatus, setStatus } = ctx;

    if (!account.wsUrl) {
      throw new Error(`[napcatqq] Account "${accountId}" has no wsUrl configured`);
    }

    // 如果已有旧连接，先停掉（防止 Gateway 多次调用 startAccount 导致泄漏）
    const oldClient = unregisterClient(accountId);
    if (oldClient) {
      log?.info(`[napcatqq] Stopping old client for account ${accountId} before restart`);
      oldClient.stop();
    }

    log?.info(`[napcatqq] Starting account ${accountId}, ws: ${account.wsUrl}`);

    // 用于存储机器人自身 QQ 号（从生命周期事件中获取）
    let selfId = account.selfId ?? "";

    // 标记当前 client 是否仍然活跃（防止旧 client 的 onDisconnected 覆盖新 client 状态）
    let clientActive = true;

    // 群聊消息历史（用于给 Agent 提供上下文）
    const groupHistories = new Map<string, HistoryEntry[]>();
    // 群聊 pairing 已批准的群号（运行时内存 + 持久化到 groupAllowFrom）
    const approvedGroups = new Set<string>(
      (account.groupAllowFrom ?? []).map(String).filter((e) => e.startsWith("g") || /^\d+$/.test(e)),
    );
    // 群聊 pairing 已通知过的群号（防止重复通知）
    const notifiedGroups = new Set<string>();
    // owner QQ 号列表（热重载，每次从最新配置读取）
    function getOwnerIds(): string[] {
      const latestCfg = getNapCatRuntime().config.loadConfig();
      const latestAccount = resolveAccount(latestCfg, accountId);
      return (latestAccount.dm?.allowFrom ?? latestAccount.allowFrom ?? []).map(String).filter(Boolean);
    }
    const historyLimit = Math.max(
      1,
      account.historyLimit ??
        (cfg as any).messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );

    // 创建 WS 客户端
    const client = new NapCatWsClient({
      wsUrl: account.wsUrl,
      accessToken: account.accessToken,
      // ChannelLogSink 的方法只接受 (msg: string)，做一层桥接
      logger: {
        info: (...args: unknown[]) => log?.info(args.map(String).join(" ")),
        warn: (...args: unknown[]) => log?.warn(args.map(String).join(" ")),
        error: (...args: unknown[]) => log?.error(args.map(String).join(" ")),
      },
      onConnected: () => {
        if (!clientActive) return;
        log?.info(`[napcatqq] Account ${accountId} connected`);
        setStatus({
          accountId,
          running: true,
          connected: true,
          lastStartAt: Date.now(),
          lastError: null,
        });
      },
      onDisconnected: () => {
        if (!clientActive) return;
        log?.warn(`[napcatqq] Account ${accountId} disconnected`);
        setStatus({
          ...getStatus(),
          connected: false,
          lastStopAt: Date.now(),
        });
      },
      onEvent: (event) => {
        // 元事件：提取 selfId
        if (event.post_type === "meta_event") {
          if (event.self_id && !selfId) {
            selfId = String(event.self_id);
            log?.info(`[napcatqq] Bot selfId detected: ${selfId}`);
          }
          return;
        }

        // 通知事件：暂不处理
        if (event.post_type === "notice") {
          return;
        }

        // 消息事件
        if (event.post_type === "message") {
          const msgEvent = event as OneBotMessageEvent;
          const inbound = normalizeInbound(msgEvent);

          log?.info(`[napcatqq] inbound: chatId=${inbound.chatId} sender=${inbound.senderId} textLen=${inbound.text.length} images=${inbound.imageUrls.length} audio=${inbound.audioUrls.length} video=${inbound.videoUrls.length} files=${inbound.fileInfos.length}`);

          // 忽略机器人自己发的消息（防止回环）
          if (selfId && inbound.senderId === selfId) {
            return;
          }

          // 群聊过滤：groupPolicy + requireMention（从最新配置读取，支持热重载）
          if (inbound.chatType === "group") {
            const latestCfg = getNapCatRuntime().config.loadConfig();
            const latestAccount = resolveAccount(latestCfg, accountId);
            const gp = latestAccount.groupPolicy ?? "disabled";

            // groupPolicy = disabled → 不响应群聊（但记录历史以备后续启用）
            if (gp === "disabled") {
              recordPendingHistoryEntryIfEnabled({
                historyMap: groupHistories,
                historyKey: inbound.chatId,
                entry: {
                  sender: inbound.senderName,
                  body: inbound.text,
                  timestamp: Date.now(),
                  messageId: inbound.messageId,
                },
                limit: historyLimit,
              });
              evictOldHistoryKeys(groupHistories);
              return;
            }

            // groupPolicy = allowlist → 检查群号是否在白名单
            if ((gp === "allowlist" || gp === "pairing") && inbound.groupId) {
              const groupAllowFrom = (latestAccount.groupAllowFrom ?? []).map(String);
              // groupAllowFrom 中可以放群号（匹配 groupId）或 QQ 号（匹配 senderId）
              const groupAllowed = groupAllowFrom.length === 0
                ? (gp === "pairing" ? approvedGroups.has(inbound.groupId) || approvedGroups.has(`g${inbound.groupId}`) : false)
                : groupAllowFrom.some((entry) => entry === "*" || entry === inbound.groupId || entry === `g${inbound.groupId}` || entry === inbound.senderId)
                  || approvedGroups.has(inbound.groupId) || approvedGroups.has(`g${inbound.groupId}`);
              if (!groupAllowed) {
                // 不在白名单 — 记录历史
                recordPendingHistoryEntryIfEnabled({
                  historyMap: groupHistories,
                  historyKey: inbound.chatId,
                  entry: {
                    sender: inbound.senderName,
                    body: inbound.text,
                    timestamp: Date.now(),
                    messageId: inbound.messageId,
                  },
                  limit: historyLimit,
                });
                evictOldHistoryKeys(groupHistories);

                // pairing 模式 → 通知 owner 审批
                if (gp === "pairing" && !notifiedGroups.has(inbound.groupId)) {
                  notifiedGroups.add(inbound.groupId);
                  const groupLabel = inbound.raw.group_name || `群${inbound.groupId}`;
                  const ownerIds = getOwnerIds();
                  if (ownerIds.length > 0) {
                    const hint = `🔔 新群请求加入

群名: ${groupLabel}
群号: ${inbound.groupId}
来自: ${inbound.senderName} (${inbound.senderId})

回复: 批准群 ${inbound.groupId}`;
                    void (async () => {
                      for (const ownerId of ownerIds) {
                        try {
                          await sendMessage(client, {
                            chatType: "direct",
                            userId: String(ownerId),
                            text: hint,
                          });
                        } catch { /* ignore */ }
                      }
                    })();
                  }
                  log?.info(`[napcatqq] group pairing request: groupId=${inbound.groupId} name=${groupLabel}`);
                }

                return;
              }
            }

            // requireMention 过滤
            if (latestAccount.requireMention !== false) {
              const mentionGate = resolveMentionGating({
                requireMention: true,
                canDetectMention: true,
                wasMentioned: isMentioningBot(inbound, selfId),
              });

              if (mentionGate.shouldSkip) {
                // 没 @ 机器人 → 记录到群聊历史（供后续回复时作上下文）
                recordPendingHistoryEntryIfEnabled({
                  historyMap: groupHistories,
                  historyKey: inbound.chatId,
                  entry: {
                    sender: inbound.senderName,
                    body: inbound.text,
                    timestamp: Date.now(),
                    messageId: inbound.messageId,
                  },
                  limit: historyLimit,
                });
                evictOldHistoryKeys(groupHistories);
                return;
              }
              // 通过了 mention 检查 → 清理 @机器人 残留
              inbound.text = stripBotMention(inbound.text, selfId);
            }
          }

          // 私聊快捷命令：「批准群 xxx」
          if (inbound.chatType === "direct" && getOwnerIds().includes(inbound.senderId)) {
            const approveMatch = inbound.text.match(/^批准群\s*(\d+)\s*$/);
            if (approveMatch) {
              const gid = approveMatch[1];
              const currentGp = resolveAccount(getNapCatRuntime().config.loadConfig(), accountId).groupPolicy ?? "disabled";
              if (currentGp !== "pairing" && currentGp !== "allowlist") {
                void (async () => {
                  try {
                    await sendMessage(client, {
                      chatType: "direct",
                      userId: inbound.senderId,
                      text: `⚠️ 当前 groupPolicy="${currentGp}"，批准群不会生效。请先设置 groupPolicy 为 pairing 或 allowlist。`,
                    });
                  } catch { /* ignore */ }
                })();
                return;
              }
              approvedGroups.add(gid);
              approvedGroups.add(`g${gid}`);
              notifiedGroups.delete(gid);

              // 持久化 + 通知（async fire-and-forget）
              void (async () => {
                try {
                  const core = getNapCatRuntime();
                  const latestCfg2 = core.config.loadConfig() as any;
                  const acctCfg = latestCfg2.channels?.napcatqq?.accounts?.[accountId];
                  if (acctCfg) {
                    const existing = (acctCfg.groupAllowFrom ?? []).map(String);
                    if (!existing.includes(`g${gid}`) && !existing.includes(gid)) {
                      acctCfg.groupAllowFrom = [...existing, `g${gid}`];
                      await core.config.writeConfigFile(latestCfg2 as OpenClawConfig);
                    }
                  }
                } catch (err) {
                  log?.warn(`[napcatqq] Failed to persist group approval: ${String(err)}`);
                }
                try {
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: inbound.senderId,
                    text: `✅ 群 ${gid} 已批准，机器人现在会响应该群的 @消息。`,
                  });
                } catch { /* ignore */ }
              })();
              log?.info(`[napcatqq] group ${gid} approved by ${inbound.senderId}`);
              return;
            }

            // 私聊快捷命令：「批准用户 xxx」
            const approveUserMatch = inbound.text.match(/^批准用户\s*(\d+)\s*$/);
            if (approveUserMatch) {
              const uid = approveUserMatch[1];
              void (async () => {
                try {
                  const core = getNapCatRuntime();
                  const latestCfg2 = core.config.loadConfig() as any;
                  const acctCfg = latestCfg2.channels?.napcatqq?.accounts?.[accountId];
                  if (acctCfg) {
                    // 写入 dm.allowFrom（与 dm.policy=pairing 配合）
                    acctCfg.dm ??= {};
                    const existing = (acctCfg.dm.allowFrom ?? acctCfg.allowFrom ?? []).map(String);
                    if (!existing.includes(uid)) {
                      acctCfg.dm.allowFrom = [...existing, uid];
                      await core.config.writeConfigFile(latestCfg2 as OpenClawConfig);
                    }
                  }
                  log?.info(`[napcatqq] user ${uid} approved by ${inbound.senderId}`);
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: inbound.senderId,
                    text: `✅ 用户 ${uid} 已批准（已写入 dm.allowFrom），现在可以和机器人私聊了。`,
                  });
                  // 通知被批准的用户
                  try {
                    await sendMessage(client, {
                      chatType: "direct",
                      userId: uid,
                      text: PAIRING_APPROVED_MESSAGE,
                    });
                  } catch { /* 可能不是好友 */ }
                } catch (err) {
                  log?.warn(`[napcatqq] Failed to approve user ${uid}: ${String(err)}`);
                  try {
                    await sendMessage(client, {
                      chatType: "direct",
                      userId: inbound.senderId,
                      text: `❌ 批准用户 ${uid} 失败: ${String(err)}`,
                    });
                  } catch { /* ignore */ }
                }
              })();
              return;
            }
          }

          // 入站消息通过防抖器排队处理
          void inboundDebouncer.enqueue(inbound).catch((err) => {
            log?.error(`[napcatqq] debouncer enqueue error: ${String(err)}`);
          });
        }
      },
    });

    // ---------- 入站消息处理函数（被 debouncer 调用） ----------
    async function handleInboundMessage(inbound: NormalizedInbound): Promise<void> {
      const core = getNapCatRuntime();

      // 获取最新配置（支持热重载）
      const latestCfg = core.config.loadConfig();

      // 1. 路由解析
      const route = core.channel.routing.resolveAgentRoute({
        cfg: latestCfg,
        channel: CHANNEL_ID,
        accountId,
        peer: {
          kind: inbound.chatType,
          id: inbound.chatId,
        },
      });

      // 2. 账号配置
      const acct = resolveAccount(latestCfg, accountId);

      // 3. DM/群聊 访问控制
      const dmPolicy = acct.dm?.policy ?? "pairing";
      const configuredAllowFrom = (acct.dm?.allowFrom ?? acct.allowFrom ?? []).map(String);

      // 群聊已在 onEvent 层通过 groupPolicy 过滤，这里统一走 DM 访问控制
      let access: ReturnType<typeof resolveDmGroupAccessWithLists>;
      if (inbound.chatType === "group") {
        // 群聊走到这里说明已通过 groupPolicy 检查，直接放行
        access = resolveDmGroupAccessWithLists({
          isGroup: true,
          dmPolicy,
          groupPolicy: "disabled",
          allowFrom: configuredAllowFrom,
          storeAllowFrom: [],
          isSenderAllowed: (allowFrom) =>
            resolveAllowlistMatchSimple({ allowFrom, senderId: inbound.senderId }).allowed,
        });
      } else {
        const pairingAccess = createScopedPairingAccess({
          core,
          channel: CHANNEL_ID,
          accountId,
        });

        const storeAllowFrom = await readStoreAllowFromForDmPolicy({
          provider: CHANNEL_ID,
          accountId: pairingAccess.accountId,
          dmPolicy,
          readStore: pairingAccess.readStoreForDmPolicy,
        });

        access = resolveDmGroupAccessWithLists({
          isGroup: false,
          dmPolicy,
          groupPolicy: "disabled",
          allowFrom: configuredAllowFrom,
          storeAllowFrom,
          isSenderAllowed: (allowFrom) =>
            resolveAllowlistMatchSimple({ allowFrom, senderId: inbound.senderId }).allowed,
        });

        // 不被允许的 DM → 处理 pairing 或丢弃
        if (access.decision !== "allow") {
          if (access.reason === "dmPolicy=disabled") {
            log?.info(`[napcatqq] dropping dm (dms disabled) sender=${inbound.senderId}`);
            return;
          }
          if (access.decision === "pairing") {
            const request = await pairingAccess.upsertPairingRequest({
              id: inbound.senderId,
              meta: { name: inbound.senderName },
            });
            if (request) {
              log?.info(`[napcatqq] pairing request created for ${inbound.senderId} (${inbound.senderName}) code=${request.code}`);
              // 通知发送者
              try {
                await sendMessage(client, {
                  chatType: "direct",
                  userId: inbound.senderId,
                  text: `⏳ 你的消息已收到，需要管理员批准后才能对话，请稍候。`,
                });
              } catch { /* ignore send error */ }
              // 通知管理员
              const preview = inbound.text.replace(/\s+/g, " ").slice(0, 100);
              const ownerHint = `🔔 新用户请求私聊

昵称: ${inbound.senderName}
QQ号: ${inbound.senderId}
消息: ${preview}

回复: 批准用户 ${inbound.senderId}`;
              for (const ownerId of getOwnerIds()) {
                if (ownerId === inbound.senderId) continue; // 不通知自己
                try {
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: ownerId,
                    text: ownerHint,
                  });
                } catch { /* ignore */ }
              }
            }
          }
          log?.info(`[napcatqq] dropping dm (not allowlisted) sender=${inbound.senderId} reason=${access.reason}`);
          return;
        }
      }

      // 4. 命令权限
      const ownerAllowed = resolveAllowlistMatchSimple({
        allowFrom: access.effectiveAllowFrom,
        senderId: inbound.senderId,
      }).allowed;
      const hasControlCmd = core.channel.text.hasControlCommand(inbound.text, latestCfg);
      const commandGate = resolveControlCommandGate({
        useAccessGroups: false,
        authorizers: [
          {
            configured: access.effectiveAllowFrom.length > 0,
            allowed: ownerAllowed,
          },
        ],
        allowTextCommands: true,
        hasControlCommand: hasControlCmd,
      });

      // 4b. 未授权的控制命令 → 直接丢弃
      if (commandGate.shouldBlock) {
        logInboundDrop({
          log: (msg) => log?.info(msg),
          channel: CHANNEL_ID,
          reason: "control command (unauthorized)",
          target: inbound.senderId,
        });
        return;
      }

      // 5. 语音转写（必须在 finalizeInboundContext 之前完成）
      if (inbound.audioUrls.length > 0) {
        for (const audioUrl of inbound.audioUrls.slice(0, 3)) {
          try {
            const controller = new AbortController();
            const fetchTimeout = setTimeout(() => controller.abort(), 30_000);
            const resp = await fetch(audioUrl, { signal: controller.signal });
            clearTimeout(fetchTimeout);
            if (!resp.ok) continue;
            const buf = Buffer.from(await resp.arrayBuffer());
            const tmpDir = "/tmp/openclaw/napcatqq-audio";
            mkdirSync(tmpDir, { recursive: true });
            const tmpFile = `${tmpDir}/${Date.now()}-${randomBytes(4).toString("hex")}.amr`;
            writeFileSync(tmpFile, buf);

            const whisperPaths = [
              `${process.env.HOME ?? "/root"}/.openclaw/workspace/skills/whisper-DL/scripts/whisper_transcribe.py`,
              "/root/.openclaw/workspace/skills/whisper-DL/scripts/whisper_transcribe.py",
            ];
            const whisperScript = whisperPaths.find(existsSync);
            if (!whisperScript) {
              log?.warn(`[napcatqq] whisper script not found, skipping voice transcription`);
              try { unlinkSync(tmpFile); } catch { /* ignore */ }
              continue;
            }

            const { stdout } = await execFileAsync(
              "python3",
              [whisperScript, tmpFile, "--provider", "cf", "--model", "@cf/openai/whisper-large-v3-turbo"],
              { timeout: 60_000, encoding: "utf-8" }
            );
            const transcript = (stdout ?? "").trim();
            try { unlinkSync(tmpFile); } catch { /* ignore */ }

            if (transcript) {
              inbound.text = inbound.text.replace("[语音消息]", `[语音转写] ${transcript}`);
              log?.info(`[napcatqq] voice transcribed: len=${transcript.length}`);
            } else {
              log?.warn(`[napcatqq] whisper returned empty transcript`);
            }
          } catch (err) {
            log?.warn(`[napcatqq] Failed to transcribe voice: ${String(err)}`);
          }
        }
      }

      // 6. 构建并最终化入站上下文
      const isGroup = inbound.chatType === "group";
      const groupName = inbound.raw.group_name;

      // 6a. 引用回复上下文（调 get_msg 获取被引用消息的内容和发送者）
      let replyToBody: string | undefined;
      let replyToSender: string | undefined;
      if (inbound.replyToMessageId) {
        const replyClient = getClient(accountId);
        if (replyClient) {
          const quoted = await getMessage(replyClient, inbound.replyToMessageId);
          if (quoted) {
            replyToBody = quoted.text || undefined;
            replyToSender = quoted.senderName || undefined;
            log?.info(`[napcatqq] reply context: sender=${quoted.senderName} textLen=${quoted.text.length}`);
          }
        }
      }

      // envelope 格式化（给 Body 加上时间戳/来源信封）
      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(latestCfg);
      const storePath = core.channel.session.resolveStorePath(latestCfg.session?.store, {
        agentId: route.agentId,
      });
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });
      const envelopeFrom = isGroup
        ? `${inbound.senderName}@${groupName || `群${inbound.groupId}`}`
        : inbound.senderName;
      const body = core.channel.reply.formatAgentEnvelope({
        channel: "QQ",
        from: envelopeFrom,
        timestamp: new Date(),
        previousTimestamp,
        envelope: envelopeOptions,
        body: inbound.text,
      });

      // system event 入队
      const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
      const inboundLabel = isGroup
        ? `QQ message in ${groupName || `群${inbound.groupId}`} from ${inbound.senderName}`
        : `QQ DM from ${inbound.senderName}`;
      core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
        sessionKey: route.sessionKey,
        contextKey: `napcatqq:message:${inbound.chatId}:${inbound.messageId}`,
      });

      // 6c. 群聊历史上下文（收集被忽略的消息作为上下文提供给 Agent）
      let combinedBody = body;
      let inboundHistory: Array<{ sender: string; body: string; timestamp: number | undefined }> | undefined;
      if (isGroup) {
        const historyText = buildPendingHistoryContextFromMap({
          historyMap: groupHistories,
          historyKey: inbound.chatId,
          limit: historyLimit,
          currentMessage: body,
          formatEntry: (entry) =>
            core.channel.reply.formatAgentEnvelope({
              channel: "QQ",
              from: `${entry.sender}@${groupName || `群${inbound.groupId}`}`,
              body: entry.body,
              timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
              envelope: envelopeOptions,
            }),
        });
        if (historyText) {
          combinedBody = historyText;
        }

        // 结构化历史（传给 InboundHistory 字段）— 在 clear 之前复制
        const entries = groupHistories.get(inbound.chatId);
        if (entries && entries.length > 0) {
          inboundHistory = entries.slice().map((e) => ({
            sender: e.sender,
            body: e.body,
            timestamp: e.timestamp,
          }));
        }

        // 清理已使用的历史
        clearHistoryEntriesIfEnabled({
          historyMap: groupHistories,
          historyKey: inbound.chatId,
          limit: historyLimit,
        });
      }

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: combinedBody,
        RawBody: inbound.text,
        CommandBody: inbound.text,
        BodyForCommands: inbound.text,
        InboundHistory: inboundHistory,
        From: inbound.senderId,
        To: inbound.chatId,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: inbound.chatType,
        ConversationLabel: envelopeFrom,
        GroupSubject: isGroup ? (groupName || `群${inbound.groupId}`) : undefined,
        SenderName: inbound.senderName,
        SenderId: inbound.senderId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        MessageSid: inbound.messageId,
        ReplyToId: inbound.replyToMessageId,
        ReplyToBody: replyToBody,
        ReplyToSender: replyToSender,
        Timestamp: Date.now(),
        WasMentioned: inbound.chatType === "direct" || isMentioningBot(inbound, selfId),
        CommandAuthorized: commandGate.commandAuthorized,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: inbound.chatId,
      });

      // 7. 记录入站会话
      core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
          log?.error(`[napcatqq] Failed to record session: ${String(err)}`);
        },
      }).catch(() => { /* recordInboundSession 内部已通过 onRecordError 报告 */ });

      // 8. 创建回复分发器（带 typing 状态 + prefix + onError）
      const typingClient = getClient(accountId);
      const typingCallbacks = (typingClient && inbound.chatType === "direct")
        ? createTypingCallbacks({
            start: async () => {
              try {
                await typingClient.callApi("set_input_status", {
                  user_id: Number(inbound.senderId),
                  event_type: 1,
                }, 5000);
              } catch { /* typing 失败不影响主流程 */ }
            },
            stop: async () => {
              try {
                await typingClient.callApi("set_input_status", {
                  user_id: Number(inbound.senderId),
                  event_type: 0,
                }, 5000);
              } catch { /* ignore */ }
            },
            onStartError: (err) => {
              logTypingFailure({
                log: (msg) => log?.warn(msg),
                channel: CHANNEL_ID,
                action: "start",
                error: err,
              });
            },
            keepaliveIntervalMs: 5000,
          })
        : undefined;

      // reply prefix（model 标签前缀，如 [gpt-4o]）
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg: latestCfg,
        agentId: route.agentId,
        channel: CHANNEL_ID,
        accountId: route.accountId,
      });

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          typingCallbacks,
          deliver: async (payload, info) => {
            log?.info(`[napcatqq] deliver: text=${!!payload.text} media=${!!payload.mediaUrl} kind=${info?.kind}`);
            const replyClient = getClient(accountId);
            if (!replyClient) {
              log?.error(`[napcatqq] deliver: no client for account ${accountId}`);
              return;
            }

            const replyTo = inbound.chatId.replace(/^napcatqq:/i, "");
            const isGroupReply = replyTo.startsWith("g");
            const replyTargetId = isGroupReply ? replyTo.slice(1) : replyTo;

            if (payload.text || payload.mediaUrl) {
              const result = await sendMessage(replyClient, {
                chatType: isGroupReply ? "group" : "direct",
                userId: isGroupReply ? undefined : replyTargetId,
                groupId: isGroupReply ? replyTargetId : undefined,
                text: payload.text || undefined,
                imageUrl: payload.mediaUrl,
              });
              if (!result.ok) {
                throw new Error(`sendMessage failed: ${result.error}`);
              }
              log?.info(`[napcatqq] deliver: ok=${result.ok} msgId=${result.messageId}`);
            }
          },
          onError: (err, info) => {
            log?.error(`[napcatqq] reply ${info.kind} failed: ${String(err)}`);
          },
        });

      // 9. 下载入站图片并转为 base64（Agent 需要 ImageContent 格式）
      const inboundImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
      if (inbound.imageUrls.length > 0) {
        for (const imgUrl of inbound.imageUrls.slice(0, 5)) { // 最多 5 张
          try {
            const controller = new AbortController();
            const fetchTimeout = setTimeout(() => controller.abort(), 30_000);
            const resp = await fetch(imgUrl, { signal: controller.signal });
            clearTimeout(fetchTimeout);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              const contentType = resp.headers.get("content-type") || "image/png";
              inboundImages.push({
                type: "image",
                data: buf.toString("base64"),
                mimeType: contentType.split(";")[0].trim(),
              });
            }
          } catch (err) {
            log?.warn(`[napcatqq] Failed to download inbound image: ${String(err)}`);
          }
        }
      }

      // 10. 分发回复（withReplyDispatcher 保障 onSettled + 异常处理）
      const finalReplyOptions = inboundImages.length > 0
        ? { ...replyOptions, images: inboundImages, onModelSelected }
        : { ...replyOptions, onModelSelected };

      try {
        await core.channel.reply.withReplyDispatcher({
          dispatcher,
          onSettled: () => {
            markDispatchIdle();
          },
          run: () =>
            core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg: latestCfg,
              dispatcher,
              replyOptions: finalReplyOptions,
            }),
        });
      } catch (err) {
        log?.error(`[napcatqq] Failed to dispatch inbound: ${String(err)}`);
      }
    }

    // ---------- 创建入站消息防抖器 ----------
    const inboundDebounceMs = getNapCatRuntime().channel.debounce.resolveInboundDebounceMs({
      cfg,
      channel: CHANNEL_ID,
    });

    const inboundDebouncer = getNapCatRuntime().channel.debounce.createInboundDebouncer<NormalizedInbound>({
      debounceMs: inboundDebounceMs,
      buildKey: (item) => {
        // 按 chatId + senderId 分组（同一个人在同一个会话的连续消息合并）
        return `napcatqq:${item.chatId}:${item.senderId}`;
      },
      shouldDebounce: (item) => {
        // 纯文本消息才防抖，有附件/命令不防抖
        if (!item.text.trim()) return false;
        if (item.imageUrls.length > 0 || item.audioUrls.length > 0) return false;
        const core = getNapCatRuntime();
        const latestCfg = core.config.loadConfig();
        return !core.channel.text.hasControlCommand(item.text, latestCfg);
      },
      onFlush: async (items) => {
        const last = items.at(-1);
        if (!last) return;
        if (items.length === 1) {
          await handleInboundMessage(last);
          return;
        }
        // 合并多条文本消息为一条
        const combinedText = items
          .map((item) => item.text)
          .filter(Boolean)
          .join("\n");
        if (!combinedText.trim()) return;
        // 使用最后一条消息为基础，合并文本
        const merged: NormalizedInbound = {
          ...last,
          text: combinedText,
          // 合并图片/音频（理论上 shouldDebounce 已排除，但兜底）
          imageUrls: items.flatMap((i) => i.imageUrls),
          audioUrls: items.flatMap((i) => i.audioUrls),
          videoUrls: items.flatMap((i) => i.videoUrls),
          fileInfos: items.flatMap((i) => i.fileInfos),
        };
        await handleInboundMessage(merged);
      },
      onError: (err) => {
        log?.error(`[napcatqq] debounce flush failed: ${String(err)}`);
      },
    });

    // 注册到全局连接池
    registerClient(accountId, client);

    // 启动连接
    client.start();

    // 探测 bot 信息（连接成功后异步获取）
    void (async () => {
      // 等待连接建立（最多 10 秒）
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const info = await getLoginInfo(client);
          if (info) {
            if (!selfId && info.userId) {
              selfId = info.userId;
            }
            log?.info(`[napcatqq] Bot probe: QQ ${info.userId} (${info.nickname})`);
            setStatus({
              ...getStatus(),
              bot: { userId: info.userId, nickname: info.nickname },
            });
            break;
          }
        } catch {
          // WS 还没连上，继续等
        }
      }
    })();

    // startAccount 的 Promise 必须保持 pending 直到 abortSignal 触发
    // Gateway 认为 Promise resolve = channel 退出 → 触发 auto-restart
    // 所以这里挂起，直到被 abort
    return new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => {
        log?.info(`[napcatqq] Abort signal received for account ${accountId}`);
        clientActive = false;
        client.stop();
        unregisterClient(accountId);
        resolve();
      }, { once: true });
    });
  },

  stopAccount: async (ctx: ChannelGatewayContext<NapCatAccountConfig>) => {
    const { accountId, log, setStatus } = ctx;
    log?.info(`[napcatqq] Stopping account ${accountId}`);

    // 从连接池取出并关闭
    const client = unregisterClient(accountId);
    if (client) {
      client.stop();
    }

    setStatus({
      accountId,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });
  },

  logoutAccount: async ({ accountId, cfg }) => {
    const nextCfg = { ...cfg } as any;
    let cleared = false;
    let changed = false;

    const accounts = nextCfg.channels?.napcatqq?.accounts;
    if (accounts && accountId in accounts) {
      const entry = accounts[accountId];
      if (entry && typeof entry === "object") {
        const nextEntry = { ...entry } as Record<string, unknown>;
        if ("accessToken" in nextEntry) {
          if (nextEntry.accessToken) cleared = true;
          delete nextEntry.accessToken;
          changed = true;
        }
        if ("wsUrl" in nextEntry) {
          if (nextEntry.wsUrl) cleared = true;
          delete nextEntry.wsUrl;
          changed = true;
        }
        if (Object.keys(nextEntry).length === 0) {
          delete accounts[accountId];
        } else {
          accounts[accountId] = nextEntry;
        }
      }
    }

    if (changed) {
      await getNapCatRuntime().config.writeConfigFile(nextCfg as OpenClawConfig);
    }

    return { cleared, loggedOut: cleared };
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
