// ============================================================
// NapCatQQ 入站消息处理器（handleInboundMessage）
// ============================================================

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
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
  resolvePreferredOpenClawTmpDir,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { NormalizedInbound } from "./inbound.js";
import { isMentioningBot } from "./inbound.js";
import { sendMessage, getMessage } from "./outbound.js";
import { getClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, resolveAccount } from "./config.js";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface HandlerContext {
  accountId: string;
  selfId: string;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  getOwnerIds: () => string[];
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export async function handleInboundMessage(
  inbound: NormalizedInbound,
  hctx: HandlerContext,
): Promise<void> {
  const { accountId, selfId, groupHistories, historyLimit, getOwnerIds, log } = hctx;
  const core = getNapCatRuntime();
  const client = getClient(accountId);

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
  const configuredAllowFrom = [
    ...(acct.dm?.allowFrom ?? []),
    ...(acct.allowFrom ?? []),
  ].map(String).filter(Boolean);

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
        if (request && client) {
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
          const ownerHint = `🔔 新用户请求私聊\n\n昵称: ${inbound.senderName}\nQQ号: ${inbound.senderId}\n消息: ${preview}\n\n回复: 批准用户 ${inbound.senderId}`;
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

  // 5. 音频下载到本地（语音转写由 SDK 内部 transcribeFirstAudio 自动处理）
  const audioMediaPaths: string[] = [];
  const audioMediaTypes: string[] = [];
  if (inbound.audioUrls.length > 0) {
    const tmpDir = join(resolvePreferredOpenClawTmpDir(), "napcatqq-audio");
    mkdirSync(tmpDir, { recursive: true });
    for (const audioUrl of inbound.audioUrls.slice(0, 3)) {
      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 30_000);
        const resp = await fetch(audioUrl, { signal: controller.signal });
        clearTimeout(fetchTimeout);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        const ext = (resp.headers.get("content-type") ?? "").includes("silk") ? ".silk" : ".amr";
        const tmpFile = `${tmpDir}/${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
        writeFileSync(tmpFile, buf);
        audioMediaPaths.push(tmpFile);
        audioMediaTypes.push(resp.headers.get("content-type")?.split(";")[0].trim() || "audio/amr");
        log?.info(`[napcatqq] audio downloaded: ${tmpFile} (${buf.length} bytes)`);
      } catch (err) {
        log?.warn(`[napcatqq] Failed to download audio: ${String(err)}`);
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
    MediaPaths: audioMediaPaths.length > 0 ? audioMediaPaths : undefined,
    MediaUrls: audioMediaPaths.length > 0 ? audioMediaPaths : undefined,
    MediaTypes: audioMediaTypes.length > 0 ? audioMediaTypes : undefined,
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
  } finally {
    // 清理音频临时文件
    for (const tmpFile of audioMediaPaths) {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}
