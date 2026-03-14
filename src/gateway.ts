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
import type { OneBotMessageEvent, OneBotRequestEvent, OneBotNoticeEvent, OneBotMessageSentEvent } from "./types.js";
import { NapCatWsClient } from "./ws-client.js";
import { normalizeInbound, isMentioningBot, stripBotMention, type NormalizedInbound } from "./inbound.js";
import {
  sendMessage, getLoginInfo,
  setFriendAddRequest, setGroupAddRequest,
  markPrivateMsgAsRead, markGroupMsgAsRead,
  setMsgEmojiLike,
  getGroupMsgHistory,
} from "./outbound.js";
import { registerClient, unregisterClient, getClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, resolveAccount } from "./config.js";
import { handleInboundMessage, type HandlerContext } from "./handler.js";

const configMutationQueues = new Map<string, Promise<void>>();

async function enqueueConfigMutation(
  accountId: string,
  mutate: (cfg: any) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  const core = getNapCatRuntime();
  const prev = configMutationQueues.get(accountId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const diskCfg = JSON.parse(JSON.stringify(core.config.loadConfig())) as any;
      const changed = await mutate(diskCfg);
      if (changed !== false) {
        await core.config.writeConfigFile(diskCfg as OpenClawConfig);
      }
    });
  configMutationQueues.set(accountId, next);
  try {
    await next;
  } finally {
    if (configMutationQueues.get(accountId) === next) {
      configMutationQueues.delete(accountId);
    }
  }
}

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
      (account.groupAllowFrom ?? [])
        .map(String)
        .map((e) => e.startsWith("g") ? e.slice(1) : e)
        .filter((e) => /^\d+$/.test(e)),
    );
    // 群聊 pairing 已通知过的群号（带 TTL，防止刷屏也避免永久静默）
    const notifiedGroups = new Map<string, number>();
    const GROUP_PAIRING_NOTIFY_TTL_MS = 30 * 60 * 1000;
    // 管理员 QQ 号列表（热重载，每次从最新配置读取）
    function getAdminIds(): string[] {
      const latestCfg = getNapCatRuntime().config.loadConfig();
      const latestAccount = resolveAccount(latestCfg, accountId);
      return [...(latestAccount.allowFrom ?? [])].map(String).filter(Boolean);
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
      getOwnerIds: getAdminIds,
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

        // 通知事件
        if (event.post_type === "notice") {
          const notice = event as OneBotNoticeEvent;

          // kick_me — 机器人被踢出群 → 自动从 groupAllowFrom 移除
          if (notice.notice_type === "group_decrease" && notice.sub_type === "kick_me" && notice.group_id) {
            const gid = String(notice.group_id);
            log?.warn(`[napcatqq] Bot kicked from group ${gid}`);
            approvedGroups.delete(gid);
            notifiedGroups.delete(gid);

            // 持久化移除（async fire-and-forget）
            void (async () => {
              try {
                let removed = false;
                await enqueueConfigMutation(accountId, async (diskCfg) => {
                  const acctCfg = diskCfg?.channels?.napcatqq?.accounts?.[accountId];
                  if (acctCfg?.groupAllowFrom) {
                    const before = acctCfg.groupAllowFrom.length;
                    acctCfg.groupAllowFrom = acctCfg.groupAllowFrom.filter(
                      (e: string | number) => String(e) !== gid && String(e) !== `g${gid}`,
                    );
                    removed = acctCfg.groupAllowFrom.length < before;
                    return removed;
                  }
                  return false;
                });
                if (removed) {
                  log?.info(`[napcatqq] Removed group ${gid} from groupAllowFrom`);
                }
              } catch (err) {
                log?.warn(`[napcatqq] Failed to remove kicked group: ${String(err)}`);
              }
              // 通知管理员
              for (const ownerId of getAdminIds()) {
                try {
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: ownerId,
                    text: `⚠️ 机器人已被移出群 ${gid}，已自动从 groupAllowFrom 中移除。`,
                  });
                } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about kick_me in group ${gid}: ${String(err)}`); }
              }
            })();
          }

          // group_ban — 机器人被禁言 → 通知管理员
          if (notice.notice_type === "group_ban" && notice.sub_type === "ban" && notice.group_id) {
            const bannedUserId = notice.user_id ? String(notice.user_id) : "";
            // 只在机器人自己被禁言时通知
            if ((bannedUserId && bannedUserId === selfId) || (!bannedUserId && notice.self_id && String(notice.self_id) === selfId)) {
              const gid = String(notice.group_id);
              const duration = notice.duration ? Number(notice.duration) : 0;
              const durationText = duration === 0 ? "永久" : `${duration}秒`;
              const operatorId = notice.operator_id ? String(notice.operator_id) : "未知";
              log?.warn(`[napcatqq] Bot muted in group ${gid} for ${durationText} by ${operatorId}`);
              void (async () => {
                for (const ownerId of getAdminIds()) {
                  try {
                    await sendMessage(client, {
                      chatType: "direct",
                      userId: ownerId,
                      text: `⚠️ 机器人在群 ${gid} 被禁言\n时长: ${durationText}\n操作者: ${operatorId}`,
                    });
                  } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about group ban in ${gid}: ${String(err)}`); }
                }
              })();
            }
          }

          // friend_add — 新好友添加成功
          if (notice.notice_type === "friend_add" && notice.user_id) {
            const uid = String(notice.user_id);
            log?.info(`[napcatqq] New friend added: ${uid}`);
            void (async () => {
              for (const ownerId of getAdminIds()) {
                try {
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: ownerId,
                    text: `ℹ️ 新好友添加成功: ${uid}`,
                  });
                } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about friend_add ${uid}: ${String(err)}`); }
              }
            })();
          }

          // notify.poke — 戳一戳事件（记录但不触发回复）
          if (notice.notice_type === "notify" && notice.sub_type === "poke") {
            log?.info(`[napcatqq] Poke event: ${notice.user_id} poked ${notice.target_id ?? "someone"} in ${notice.group_id ?? "private"}`);
          }

          // bot_offline — 机器人离线通知
          if (notice.notice_type === "bot_offline") {
            const tag = notice.tag ? String(notice.tag) : "";
            const message = notice.message ? String(notice.message) : "";
            log?.warn(`[napcatqq] Bot offline: ${tag} ${message}`);
            void (async () => {
              for (const ownerId of getAdminIds()) {
                try {
                  await sendMessage(client, {
                    chatType: "direct",
                    userId: ownerId,
                    text: `⚠️ 机器人离线: ${tag} ${message}`.trim(),
                  });
                } catch { /* ignore */ }
              }
            })();
          }

          return;
        }

        // 请求事件
        if (event.post_type === "request") {
          const req = event as OneBotRequestEvent;
          const latestCfg = getNapCatRuntime().config.loadConfig();
          const latestAccount = resolveAccount(latestCfg, accountId);

          // 好友请求 → 自动同意
          if (req.request_type === "friend") {
            const autoAccept = latestAccount.autoAcceptFriend === true; // 默认 false
            log?.info(`[napcatqq] Friend request from ${req.user_id}, comment="${req.comment ?? ""}", autoAccept=${autoAccept}`);
            if (autoAccept) {
              void (async () => {
                const ok = await setFriendAddRequest(client, req.flag, true);
                if (ok) {
                  log?.info(`[napcatqq] Auto-accepted friend request from ${req.user_id}`);
                  // 通知管理员
                  for (const ownerId of getAdminIds()) {
                    try {
                      await sendMessage(client, {
                        chatType: "direct",
                        userId: ownerId,
                        text: `ℹ️ 已自动同意好友请求: ${req.user_id}${req.comment ? ` (验证消息: ${req.comment})` : ""}`,
                      });
                    } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about auto-accepted friend ${req.user_id}: ${String(err)}`); }
                  }
                } else {
                  log?.warn(`[napcatqq] Failed to accept friend request from ${req.user_id}`);
                }
              })();
            }
          }

          // 入群邀请 → 自动同意
          if (req.request_type === "group" && req.sub_type === "invite") {
            const autoAccept = latestAccount.autoAcceptGroupInvite === true; // 默认 false
            log?.info(`[napcatqq] Group invite to ${req.group_id} from ${req.user_id}, autoAccept=${autoAccept}`);
            if (autoAccept) {
              void (async () => {
                const ok = await setGroupAddRequest(client, req.flag, "invite", true);
                if (ok) {
                  log?.info(`[napcatqq] Auto-accepted group invite to ${req.group_id}`);
                  // 通知管理员
                  for (const ownerId of getAdminIds()) {
                    try {
                      await sendMessage(client, {
                        chatType: "direct",
                        userId: ownerId,
                        text: `ℹ️ 已自动同意入群邀请: 群${req.group_id} (邀请人: ${req.user_id})`,
                      });
                    } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about auto-accepted group invite ${req.group_id}: ${String(err)}`); }
                  }
                } else {
                  log?.warn(`[napcatqq] Failed to accept group invite to ${req.group_id}`);
                }
              })();
            }
          }
          return;
        }

        // message_sent — 记录机器人自发消息（需 NapCat 开启 reportSelfMessage）
        if (event.post_type === "message_sent") {
          const sentEvent = event as OneBotMessageSentEvent;
          const chatId = sentEvent.message_type === "group"
            ? `napcatqq:g${sentEvent.group_id}`
            : `napcatqq:${sentEvent.target_id ?? sentEvent.user_id}`;
          const textContent = typeof sentEvent.message === "string"
            ? sentEvent.message
            : Array.isArray(sentEvent.message)
              ? sentEvent.message.map((s: any) => {
                  if (s.type === "text") return s.data?.text ?? "";
                  if (s.type === "image") return "[图片]";
                  if (s.type === "record") return "[语音消息]";
                  if (s.type === "video") return "[视频消息]";
                  if (s.type === "file") return `[文件:${s.data?.name ?? s.data?.file ?? "未知文件"}]`;
                  return "";
                }).join("")
              : sentEvent.raw_message ?? "";

          if (textContent.trim()) {
            // 群聊：记入 groupHistories，让 Agent 知道自己说过什么
            if (sentEvent.message_type === "group" && sentEvent.group_id) {
              const botName = sentEvent.sender?.nickname || selfId || "Bot";
              recordPendingHistoryEntryIfEnabled({
                historyMap: groupHistories,
                historyKey: chatId,
                entry: {
                  sender: `${botName}(Bot)`,
                  body: textContent.trim(),
                  timestamp: Date.now(),
                  messageId: String(sentEvent.message_id),
                },
                limit: historyLimit,
              });
            }
            log?.info(`[napcatqq] message_sent recorded: chatId=${chatId} textLen=${textContent.length}`);
          }
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

          // 忽略空消息（无文本、无图片、无音频、无视频、无文件 — 可能是客户端操作触发的空事件）
          if (!inbound.text.trim() && inbound.imageUrls.length === 0 && inbound.audioUrls.length === 0 && inbound.videoUrls.length === 0 && inbound.fileInfos.length === 0) {
            log?.info(`[napcatqq] dropping empty message from ${inbound.senderId}`);
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
                ? (gp === "pairing" ? approvedGroups.has(inbound.groupId) : false)
                : groupAllowFrom.some((entry) => entry === "*" || entry === inbound.groupId || entry === `g${inbound.groupId}`)
                  || approvedGroups.has(inbound.groupId);
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
                const lastNotifiedAt = notifiedGroups.get(inbound.groupId) ?? 0;
                if (gp === "pairing" && Date.now() - lastNotifiedAt >= GROUP_PAIRING_NOTIFY_TTL_MS) {
                  notifiedGroups.set(inbound.groupId, Date.now());
                  const groupLabel = inbound.raw.group_name || `群${inbound.groupId}`;
                  const ownerIds = getAdminIds();
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
                        } catch (err) { log?.warn(`[napcatqq] failed to notify admin ${ownerId} about group pairing ${inbound.groupId}: ${String(err)}`); }
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
          if (inbound.chatType === "direct" && getAdminIds().includes(inbound.senderId)) {
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
              notifiedGroups.delete(gid);

              // 持久化 + 通知（async fire-and-forget）
              void (async () => {
                try {
                  await enqueueConfigMutation(accountId, async (latestCfg2) => {
                    const acctCfg = latestCfg2.channels?.napcatqq?.accounts?.[accountId];
                    if (acctCfg) {
                      const existing = (acctCfg.groupAllowFrom ?? []).map(String);
                      if (!existing.includes(`g${gid}`) && !existing.includes(gid)) {
                        acctCfg.groupAllowFrom = [...existing, `g${gid}`];
                        return true;
                      }
                    }
                    return false;
                  });
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
                  await enqueueConfigMutation(accountId, async (latestCfg2) => {
                    const acctCfg = latestCfg2.channels?.napcatqq?.accounts?.[accountId];
                    if (acctCfg) {
                      // 写入 dm.allowFrom（与 dm.policy=pairing 配合）
                      acctCfg.dm ??= {};
                      const existing = (acctCfg.dm.allowFrom ?? []).map(String);
                      if (!existing.includes(uid)) {
                        acctCfg.dm.allowFrom = [...existing, uid];
                        return true;
                      }
                    }
                    return false;
                  });
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
        if (item.imageUrls.length > 0 || item.audioUrls.length > 0 || item.videoUrls.length > 0 || item.fileInfos.length > 0) return false;
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
        if (!clientActive || abortSignal.aborted) return;
        await new Promise((r) => setTimeout(r, 500));
        if (!clientActive || abortSignal.aborted) return;
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

              let syncedCount = 0;
              await enqueueConfigMutation(accountId, async (latestCfgQueued) => {
                const acctCfgQueued = latestCfgQueued?.channels?.napcatqq?.accounts?.[accountId];
                if (!acctCfgQueued) return false;

                let changed = false;
                if (info.userId && acctCfgQueued.selfId !== info.userId) {
                  acctCfgQueued.selfId = info.userId;
                  changed = true;
                }

                if (storeAllowFrom.length > 0) {
                  acctCfgQueued.dm ??= {};
                  const existingQueued = new Set((acctCfgQueued.dm.allowFrom ?? []).map(String));
                  const mergedQueued = [...existingQueued];
                  for (const id of storeAllowFrom) {
                    if (!existingQueued.has(id)) {
                      mergedQueued.push(id);
                      syncedCount++;
                      changed = true;
                    }
                  }
                  if (syncedCount > 0) {
                    acctCfgQueued.dm.allowFrom = mergedQueued;
                  }
                }
                return changed;
              });

              if (info.userId) {
                log?.info(`[napcatqq] selfId synced to config: ${info.userId}`);
              }
              if (syncedCount > 0) {
                log?.info(`[napcatqq] synced ${syncedCount} users from pairing store to dm.allowFrom`);
              }
            } catch (err) {
              log?.warn(`[napcatqq] Failed to sync config on startup: ${String(err)}`);
            }

            // 启动时加载已批准群的历史消息（恢复重启前的上下文）
            try {
              const latestCfg3 = getNapCatRuntime().config.loadConfig();
              const latestAccount3 = resolveAccount(latestCfg3, accountId);
              const groupIds = (latestAccount3.groupAllowFrom ?? [])
                .map(String)
                .map((e) => e.startsWith("g") ? e.slice(1) : e)
                .filter((e) => /^\d+$/.test(e));

              if (groupIds.length > 0) {
                log?.info(`[napcatqq] Loading history for ${groupIds.length} approved groups...`);
                const loadCount = Math.min(historyLimit, 50); // 最多加载 50 条
                for (const gid of groupIds) {
                  try {
                    const messages = await getGroupMsgHistory(client, gid, loadCount);
                    if (messages.length > 0) {
                      const chatId = `napcatqq:g${gid}`;
                      // 按时间顺序插入，跳过机器人自己的消息
                      const botId = selfId;
                      for (const msg of messages) {
                        if (botId && String(msg.user_id) === botId) {
                          // 机器人自己的消息也记录（带 Bot 标记）
                          recordPendingHistoryEntryIfEnabled({
                            historyMap: groupHistories,
                            historyKey: chatId,
                            entry: {
                              sender: `${msg.nickname}(Bot)`,
                              body: msg.content,
                              timestamp: msg.time * 1000,
                              messageId: String(msg.message_id),
                            },
                            limit: historyLimit,
                          });
                        } else if (msg.content.trim()) {
                          recordPendingHistoryEntryIfEnabled({
                            historyMap: groupHistories,
                            historyKey: chatId,
                            entry: {
                              sender: msg.nickname,
                              body: msg.content,
                              timestamp: msg.time * 1000,
                              messageId: String(msg.message_id),
                            },
                            limit: historyLimit,
                          });
                        }
                      }
                      log?.info(`[napcatqq] Loaded ${messages.length} history messages for group ${gid}`);
                    }
                  } catch (err) {
                    log?.warn(`[napcatqq] Failed to load history for group ${gid}: ${String(err)}`);
                  }
                }
              }
            } catch (err) {
              log?.warn(`[napcatqq] Failed to load group histories on startup: ${String(err)}`);
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
