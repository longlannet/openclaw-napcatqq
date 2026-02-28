// ============================================================
// NapCatQQ Onboarding + Setup 适配器
// ============================================================

import type {
  ChannelOnboardingAdapter,
  ChannelSetupAdapter,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { CHANNEL_ID, listAccountIds, resolveAccount, isAccountConfigured } from "./config.js";

// ---------- Onboarding 适配器（openclaw channels login 向导） ----------

export const onboarding: ChannelOnboardingAdapter = {
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

// ---------- Setup 适配器（openclaw channels add 命令） ----------

export const setup: ChannelSetupAdapter = {
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
