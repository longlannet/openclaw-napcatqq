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
import { sendMessage, getMessage, getFileUrl, setMsgEmojiLike, markPrivateMsgAsRead, markGroupMsgAsRead } from "./outbound.js";
import { getClient } from "./client-store.js";
import { getNapCatRuntime } from "./runtime.js";
import { CHANNEL_ID, resolveAccount } from "./config.js";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
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
  // peer.id 不带 channel 前缀 — SDK 内部会自动拼接 channel:peerKind:peerId
  const peerId = inbound.chatId.replace(/^napcatqq:/i, "");
  const route = core.channel.routing.resolveAgentRoute({
    cfg: latestCfg,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: inbound.chatType,
      id: peerId,
    },
  });

  // 2. 账号配置
  const acct = resolveAccount(latestCfg, accountId);

  // 2b. 标记已读（fire-and-forget）
  if (client) {
    if (inbound.chatType === "group" && inbound.groupId) {
      void markGroupMsgAsRead(client, inbound.groupId).catch(() => {});
    } else if (inbound.chatType === "direct") {
      void markPrivateMsgAsRead(client, inbound.senderId).catch(() => {});
    }
  }

  // 2c. Emoji ack（收到消息时打表情回应 — 处理中）
  const emojiAckEnabled = acct.emojiAck === true;
  if (emojiAckEnabled && client) {
    // 66 = 爱心，表示"收到/处理中"
    void setMsgEmojiLike(client, inbound.messageId, "66").catch(() => {});
  }

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
        let resp;
        try {
          resp = await fetch(audioUrl, { signal: controller.signal });
        } finally {
          clearTimeout(fetchTimeout);
        }
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

  // 5b. 视频 URL（不下载，将 URL 信息附加给 Agent 参考）
  if (inbound.videoUrls.length > 0) {
    if (inbound.videoUrls.length === 1) {
      inbound.text = inbound.text.replace("[视频消息]", `[视频消息: ${inbound.videoUrls[0]}]`);
    } else {
      // 多视频：替换所有 [视频消息] 为带序号和 URL 的版本
      let videoIdx = 0;
      inbound.text = inbound.text.replace(/\[视频消息\]/g, () => {
        const url = inbound.videoUrls[videoIdx] ?? "";
        videoIdx++;
        return url ? `[视频${videoIdx}: ${url}]` : `[视频${videoIdx}]`;
      });
    }
  }

  // 5c. 文件处理（尝试获取下载链接或直接提取 base64 下载到本地临时目录）
  if (inbound.fileInfos && inbound.fileInfos.length > 0) {
    const client = getClient(accountId);
    for (const file of inbound.fileInfos) {
      let finalUrl = file.url;
      if (!finalUrl && file.fileId && client) {
        // 通过 API 请求文件数据
        const fileData = await getFileUrl(client, file.fileId, inbound.chatType, inbound.groupId);
        if (fileData) {
          if (fileData.url) {
            finalUrl = fileData.url;
          } else if (fileData.base64) {
            // 如果 NapCat 返回了 base64 数据，直接在 OpenClaw 所在服务器落地为文件
            try {
              const fileTmpDir = resolvePreferredOpenClawTmpDir();
              const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
              const localPath = join(fileTmpDir, `${Date.now()}_${safeName}`);
              writeFileSync(localPath, Buffer.from(fileData.base64, "base64"));
              finalUrl = `file://${localPath}`;
              log?.info(`[napcatqq] Wrote base64 file to local path: ${localPath}`);
            } catch (e) {
              log?.error(`[napcatqq] Failed to write base64 file: ${String(e)}`);
            }
          } else if (fileData.path) {
            // 兜底：如果都没有，就把 NapCat 那边的绝对路径塞进去（虽然通常不在同一台机器，但聊胜于无）
            finalUrl = fileData.path;
          }
        }
      }
      if (finalUrl) {
        const searchRegex = new RegExp(`\\[文件:\\s*${file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\([^)]+\\))?\\]`, 'g');
        inbound.text = inbound.text.replace(searchRegex, `[文件: ${file.name} (URL: ${finalUrl})]`);
        log?.info(`[napcatqq] Resolved file URL for ${file.name}: ${finalUrl}`);
      } else {
        log?.warn(`[napcatqq] File info missing URL: ${JSON.stringify(file)}`);
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

  // envelope 格式化
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(latestCfg);
  const storePath = core.channel.session.resolveStorePath(latestCfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeFrom = isGroup
    ? `${groupName || `群${inbound.groupId}`} (qq-group:${inbound.groupId})`
    : `${inbound.senderName} (qq:${inbound.senderId})`;
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "QQ",
    from: envelopeFrom,
    timestamp: new Date(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: inbound.text,
    chatType: inbound.chatType,
    senderLabel: inbound.senderName,
  });

  // system event 入队（仅群聊 — Telegram 普通消息入站也不调此函数）
  if (isGroup) {
    const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = `QQ message in ${groupName || `群${inbound.groupId}`} from ${inbound.senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `napcatqq:message:${inbound.chatId}:${inbound.messageId}`,
    });
  }

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
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    BodyForCommands: inbound.text,
    InboundHistory: inboundHistory,
    From: isGroup ? `qq-group:${inbound.groupId}` : `qq:${inbound.senderId}`,
    To: isGroup ? `qq-group:${inbound.groupId}` : `qq:${inbound.senderId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: inbound.chatType,
    ConversationLabel: envelopeFrom,
    GroupSubject: isGroup ? (groupName ? `${groupName} (${inbound.groupId})` : `群${inbound.groupId}`) : undefined,
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
    MediaUrls: inbound.audioUrls.length > 0 ? inbound.audioUrls : undefined,
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

  // 同一轮回复内媒体去重：避免 tool 阶段发了语音，final 阶段又把同一 mp3 当文件再发一遍
  const sentMediaInThisTurn = new Set<string>();

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      typingCallbacks,
      deliver: async (payload, info) => {
        const payloadAny = payload as any;
        const mediaUrls = Array.isArray(payloadAny.mediaUrls) ? payloadAny.mediaUrls.filter(Boolean).map(String) : [];
        let text = payload.text ?? "";
        let mediaUrl = payload.mediaUrl ?? mediaUrls[0] ?? "";

        // 兼容工具输出里的 MEDIA token（例如 MEDIA:/tmp/...）
        if (!mediaUrl && text.includes("MEDIA:")) {
          const mediaMatch = text.match(/\bMEDIA:\s*`?([^`\n]+)`?/i);
          if (mediaMatch?.[1]) {
            mediaUrl = mediaMatch[1].trim();
            text = text.replace(mediaMatch[0], "").trim();
          }
        }

        // 兜底：某些链路会把 /tmp/openclaw/tts-... 路径直接写进文本（没有 MEDIA: 前缀）
        if (!mediaUrl) {
          const rawPathMatch = text.match(/(\/tmp\/openclaw\/tts-[^\s`"']+\/voice-[^\s`"']+\.(mp3|ogg|wav|m4a|amr|silk|flac|aac))/i);
          if (rawPathMatch?.[1]) {
            mediaUrl = rawPathMatch[1].trim();
            text = text.replace(rawPathMatch[1], "").trim();
          }
        }

        // 去重：同一轮内若已发送过同一媒体，不重复发送
        const mediaDedupKey = mediaUrl ? mediaUrl.replace(/^MEDIA:\s*/i, "").trim() : "";
        if (mediaDedupKey && sentMediaInThisTurn.has(mediaDedupKey)) {
          log?.info(`[napcatqq] deliver: skip duplicate media in same turn: ${mediaDedupKey}`);
          // 若重复媒体还带文本，仅发送文本
          mediaUrl = "";
        }

        log?.info(`[napcatqq] deliver: kind=${info?.kind} text=${!!text} media=${!!mediaUrl} mediaCount=${mediaUrls.length} keys=${Object.keys(payload).join(",")}`);

        const replyClient = getClient(accountId);
        if (!replyClient) {
          log?.error(`[napcatqq] deliver: no client for account ${accountId}`);
          return;
        }

        const replyTo = inbound.chatId.replace(/^napcatqq:/i, "");
        const isGroupReply = replyTo.startsWith("g");
        const replyTargetId = isGroupReply ? replyTo.slice(1) : replyTo;

        if (text || mediaUrl) {
          // 检测媒体类型
          const mimeType = String(payloadAny.mediaContentType ?? "");
          const audioAsVoice = payloadAny.audioAsVoice === true;
          const isAudio = audioAsVoice || mimeType.startsWith("audio/") ||
            /\.(mp3|ogg|wav|amr|silk|m4a|flac|aac)$/i.test(mediaUrl);
          const isVideo = mimeType.startsWith("video/") ||
            /\.(mp4|avi|mkv|mov|webm)$/i.test(mediaUrl);

          const result = await sendMessage(replyClient, {
            chatType: isGroupReply ? "group" : "direct",
            userId: isGroupReply ? undefined : replyTargetId,
            groupId: isGroupReply ? replyTargetId : undefined,
            text: text || undefined,
            imageUrl: (!isAudio && !isVideo) ? mediaUrl || undefined : undefined,
            voiceUrl: isAudio ? mediaUrl : undefined,
            videoUrl: isVideo ? mediaUrl : undefined,
          });
          if (!result.ok) {
            throw new Error(`sendMessage failed: ${result.error}`);
          }
          if (mediaDedupKey && mediaUrl) sentMediaInThisTurn.add(mediaDedupKey);
          log?.info(`[napcatqq] deliver: sent type=${isAudio ? "record" : (isVideo ? "video" : (mediaUrl ? "image" : "text"))} ok=${result.ok} msgId=${result.messageId}`);
          
          // 【增强 Agent 记忆】：将发送成功的消息 ID 通过系统事件告知 Agent，以便实现“撤回”等 Action
          if (result.messageId) {
            core.system.enqueueSystemEvent(`[系统提示] 你刚刚发送了一条消息，请记住该消息的 messageId: ${result.messageId} (若需撤回或回应，请使用此 ID)`, {
              sessionKey: route.sessionKey,
              contextKey: `napcatqq:outbound:${result.messageId}`,
            });
          }
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
        try {
          const resp = await fetch(imgUrl, { signal: controller.signal });
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const contentType = resp.headers.get("content-type") || "image/png";
            inboundImages.push({
              type: "image",
              data: buf.toString("base64"),
              mimeType: contentType.split(";")[0].trim(),
            });
          }
        } finally {
          clearTimeout(fetchTimeout);
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
