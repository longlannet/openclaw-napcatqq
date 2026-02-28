// ============================================================
// NapCatQQ 配置适配器
// ============================================================

import type {
  ChannelConfigAdapter,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
} from "openclaw/plugin-sdk";
import type { NapCatAccountConfig } from "./types.js";

export const CHANNEL_ID = "napcatqq" as const;

// ---------- 配置读取辅助 ----------

export function getAccountsRecord(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg as any).channels?.napcatqq?.accounts ?? {};
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(getAccountsRecord(cfg));
}

export function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): NapCatAccountConfig {
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
    // v0.5 新增
    autoAcceptFriend: raw.autoAcceptFriend as boolean | undefined,
    autoAcceptGroupInvite: raw.autoAcceptGroupInvite as boolean | undefined,
    emojiAck: raw.emojiAck as boolean | undefined,
  };
}

export function isAccountConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const account = resolveAccount(cfg, accountId);
  return !!account.wsUrl;
}

// ---------- 配置适配器 ----------

export const config: ChannelConfigAdapter<NapCatAccountConfig> = {
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
    return [...(account.dm?.allowFrom ?? []), ...(account.allowFrom ?? [])];
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
