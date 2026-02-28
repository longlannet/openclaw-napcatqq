// ============================================================
// NapCatQQ 网关适配器（WS 长连接管理）
// ============================================================

import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_GROUP_HISTORY_LIMIT,
  PAIRING_APPROVED_MESSAGE,
  createScopedPairingAccess,
  readStoreAllowFromForDmPolicy,
  resolveMentionGating,
  recordPendingHistoryEntryIfEnabled,
  evictOldHistoryKeys,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { NapCatAccountConfig } from "./types.js";
import type { OneBotMessageEvent } from "./types.js";
import { NapCatWsClient } from "./ws-client.js";
import { normalizeInbound, isMentioningBot, stripBotMention, type NormalizedInbound } from "./inbound.js";
import { sendMessage, getLoginInfo } from "./outbound.js";
import { registerClient, unregisterClient, getClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, resolveAccount } from "./config.js";
import { handleInboundMessage, type HandlerContext } from "./handler.js";

export const gateway: ChannelGatewayAdapter<NapCatAccountConfig> = {
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
      return [...(latestAccount.dm?.allowFrom ?? []), ...(latestAccount.allowFrom ?? [])].map(String).filter(Boolean);
    }
    const historyLimit = Math.max(
      1,
      account.historyLimit ??
        (cfg as any).messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );

    // handler context（传给 handleInboundMessage）
    const hctx: HandlerContext = {
      accountId,
      get selfId() { return selfId; },
      groupHistories,
      historyLimit,
      getOwnerIds,
      log: log ? {
        info: (msg: string) => log.info(msg),
        warn: (msg: string) => log.warn(msg),
        error: (msg: string) => log.error(msg),
      } : undefined,
    };

    // 创建 WS 客户端
    const client = new NapCatWsClient({
      wsUrl: account.wsUrl,
      accessToken: account.accessToken,
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
                    const hint = `🔔 新群请求加入\n\n群名: ${groupLabel}\n群号: ${inbound.groupId}\n来自: ${inbound.senderName} (${inbound.senderId})\n\n回复: 批准群 ${inbound.groupId}`;
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
                  const latestCfg2 = JSON.parse(JSON.stringify(core.config.loadConfig())) as any;
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
                  const latestCfg2 = JSON.parse(JSON.stringify(core.config.loadConfig())) as any;
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

    // ---------- 创建入站消息防抖器 ----------
    const inboundDebounceMs = getNapCatRuntime().channel.debounce.resolveInboundDebounceMs({
      cfg,
      channel: CHANNEL_ID,
    });

    const inboundDebouncer = getNapCatRuntime().channel.debounce.createInboundDebouncer<NormalizedInbound>({
      debounceMs: inboundDebounceMs,
      buildKey: (item) => {
        return `napcatqq:${item.chatId}:${item.senderId}`;
      },
      shouldDebounce: (item) => {
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
          await handleInboundMessage(last, hctx);
          return;
        }
        // 合并多条文本消息为一条
        const combinedText = items
          .map((item) => item.text)
          .filter(Boolean)
          .join("\n");
        if (!combinedText.trim()) return;
        const merged: NormalizedInbound = {
          ...last,
          text: combinedText,
          imageUrls: items.flatMap((i) => i.imageUrls),
          audioUrls: items.flatMap((i) => i.audioUrls),
          videoUrls: items.flatMap((i) => i.videoUrls),
          fileInfos: items.flatMap((i) => i.fileInfos),
        };
        await handleInboundMessage(merged, hctx);
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
            // 启动后一次性同步：selfId 回写 + pairing store → dm.allowFrom
            try {
              const core = getNapCatRuntime();
              const diskCfg = JSON.parse(JSON.stringify(core.config.loadConfig())) as any;
              const acctCfg = diskCfg?.channels?.napcatqq?.accounts?.[accountId];
              if (acctCfg) {
                let needsWrite = false;

                // 回写 selfId
                if (info.userId && acctCfg.selfId !== info.userId) {
                  acctCfg.selfId = info.userId;
                  needsWrite = true;
                  log?.info(`[napcatqq] selfId written to config: ${info.userId}`);
                }

                // 同步 credentials pairing store 到 dm.allowFrom
                const pairingAccess = createScopedPairingAccess({
                  core,
                  channel: CHANNEL_ID,
                  accountId,
                });
                const storeAllowFrom = await readStoreAllowFromForDmPolicy({
                  provider: CHANNEL_ID,
                  accountId: pairingAccess.accountId,
                  dmPolicy: "pairing",
                  readStore: pairingAccess.readStoreForDmPolicy,
                });
                if (storeAllowFrom.length > 0) {
                  acctCfg.dm ??= {};
                  const existing = new Set((acctCfg.dm.allowFrom ?? []).map(String));
                  const merged = [...existing];
                  let added = 0;
                  for (const id of storeAllowFrom) {
                    if (!existing.has(id)) {
                      merged.push(id);
                      added++;
                    }
                  }
                  if (added > 0) {
                    acctCfg.dm.allowFrom = merged;
                    needsWrite = true;
                    log?.info(`[napcatqq] synced ${added} users from pairing store to dm.allowFrom`);
                  }
                }

                if (needsWrite) {
                  await core.config.writeConfigFile(diskCfg as OpenClawConfig);
                }
              }
            } catch (err) {
              log?.warn(`[napcatqq] Failed to sync config on startup: ${String(err)}`);
            }
            break;
          }
        } catch {
          // WS 还没连上，继续等
        }
      }
    })();

    // startAccount 的 Promise 必须保持 pending 直到 abortSignal 触发
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
