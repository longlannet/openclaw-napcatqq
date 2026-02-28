// ============================================================
// 出站消息处理 — OpenClaw 回复 → NapCat API 调用
// ============================================================

import { readFileSync, existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { NapCatWsClient } from "./ws-client.js";
import type { OneBotSegment } from "./types.js";
import { QQ_FACE_EMOJI_MAP } from "./inbound.js";

/**
 * 如果是本地文件路径，读取并转成 base64:// 前缀（跨服务器兼容）。
 * 如果是 URL 或已经是 base64://，原样返回。
 */
type ResolvedMedia = { file: string; name?: string; missingLocal?: boolean };

function resolveFileToBase64(filePath: string, kind?: "audio" | "video" | "image"): ResolvedMedia {
  // 兼容 MEDIA: 前缀
  const normalized = filePath.replace(/^MEDIA:\s*/i, "").replace(/^`|`$/g, "").trim();

  // 已经是 URL 或 base64
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith("base64://")) {
    return { file: normalized };
  }

  // 对于本地绝对路径：必须存在才允许继续，否则不要回退原样（NapCat 无法访问 OpenClaw 本地路径）
  const looksLocalPath = normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../") || /^[a-zA-Z]:[\\/]/.test(normalized);

  // 本地文件路径 → 读取转 base64（跨服务器部署必须）
  if (existsSync(normalized)) {
    let buf: Buffer;
    try {
      buf = readFileSync(normalized);
    } catch {
      return { file: normalized, missingLocal: true };
    }

    if (!buf || buf.length === 0) {
      return { file: normalized, missingLocal: true };
    }
    const name = basename(normalized) || undefined;

    return {
      file: `base64://${buf.toString("base64")}`,
      name,
    };
  }

  // 本地路径但文件不存在：不要把本机路径透传给 NapCat（它无法访问）
  if (looksLocalPath) {
    return { file: normalized, missingLocal: true };
  }

  // 其他情况（可能是可访问的 URI），原样返回让 NapCat 尝试
  return { file: normalized };
}

export interface SendOptions {
  chatType: "direct" | "group";
  userId?: string;
  groupId?: string;
  text?: string;
  imageUrl?: string;          // 图片 URL 或 base64
  voiceUrl?: string;          // 语音文件 URL 或 base64（record 消息段）
  videoUrl?: string;          // 视频文件 URL 或 base64（video 消息段）
  replyToMessageId?: string;  // 引用回复
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * 发送消息到 QQ（私聊或群聊）
 */
export async function sendMessage(client: NapCatWsClient, opts: SendOptions): Promise<SendResult> {
  const segments: OneBotSegment[] = [];

  // 引用回复
  if (opts.replyToMessageId) {
    segments.push({
      type: "reply",
      data: { id: opts.replyToMessageId },
    });
  }

  // 文本
  if (opts.text) {
    segments.push({
      type: "text",
      data: { text: opts.text },
    });
  }

  // 图片
  if (opts.imageUrl) {
    const resolved = resolveFileToBase64(opts.imageUrl, "image");
    if (resolved.missingLocal) {
      return { ok: false, error: `Local media file missing/unreadable: ${opts.imageUrl}` };
    }
    segments.push({
      type: "image",
      data: {
        file: resolved.file,
        ...(resolved.name ? { name: resolved.name } : {}),
      },
    });
  }

  // 语音（QQ 协议要求语音必须单独发送，不能混合其他消息段）
  if (opts.voiceUrl) {
    // 如果有文本，先发文本再发语音
    if (opts.text && segments.length > 0) {
      const textAction = opts.chatType === "group" ? "send_group_msg" : "send_private_msg";
      const textParams: Record<string, unknown> = { message: [...segments] };
      if (opts.chatType === "group") textParams.group_id = Number(opts.groupId);
      else textParams.user_id = Number(opts.userId);
      try { await client.callApi(textAction, textParams); } catch { /* ignore text send error */ }
      segments.length = 0; // 清空已发的文本段
    }
    const resolved = resolveFileToBase64(opts.voiceUrl, "audio");
    if (resolved.missingLocal) {
      return { ok: false, error: `Local voice file missing/unreadable: ${opts.voiceUrl}` };
    }
    segments.push({
      type: "record",
      data: {
        file: resolved.file,
        ...(resolved.name ? { name: resolved.name } : {}),
      },
    });
  }

  // 视频（QQ 协议要求视频必须单独发送，不能混合其他消息段）
  if (opts.videoUrl) {
    if (segments.length > 0) {
      const textAction = opts.chatType === "group" ? "send_group_msg" : "send_private_msg";
      const textParams: Record<string, unknown> = { message: [...segments] };
      if (opts.chatType === "group") textParams.group_id = Number(opts.groupId);
      else textParams.user_id = Number(opts.userId);
      try { await client.callApi(textAction, textParams); } catch { /* ignore */ }
      segments.length = 0;
    }
    const resolved = resolveFileToBase64(opts.videoUrl, "video");
    if (resolved.missingLocal) {
      return { ok: false, error: `Local video file missing/unreadable: ${opts.videoUrl}` };
    }
    segments.push({
      type: "video",
      data: {
        file: resolved.file,
        ...(resolved.name ? { name: resolved.name } : {}),
      },
    });
  }

  if (segments.length === 0) {
    return { ok: false, error: "Nothing to send (no text, image, voice, video, or reply)" };
  }

  const action = opts.chatType === "group" ? "send_group_msg" : "send_private_msg";
  const params: Record<string, unknown> = { message: segments };

  if (opts.chatType === "group") {
    if (!opts.groupId) return { ok: false, error: "Missing groupId for group message" };
    params.group_id = Number(opts.groupId);
  } else {
    if (!opts.userId) return { ok: false, error: "Missing userId for private message" };
    params.user_id = Number(opts.userId);
  }

  try {
    const resp = await client.callApi(action, params);

    if (resp.status === "ok" && resp.data) {
      return {
        ok: true,
        messageId: (resp.data as { message_id?: number }).message_id,
      };
    }

    return {
      ok: false,
      error: `API returned status=${resp.status} retcode=${resp.retcode}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 通过 get_msg API 获取消息内容（用于引用回复上下文）
 */
export async function getMessage(
  client: NapCatWsClient,
  messageId: string,
): Promise<{ text: string; senderId: string; senderName: string } | null> {
  try {
    const resp = await client.callApi("get_msg", { message_id: Number(messageId) }, 5000);
    if (resp.status !== "ok" || !resp.data) return null;

    const data = resp.data as {
      message_id?: number;
      sender?: { user_id?: number; nickname?: string; card?: string };
      message?: Array<{ type: string; data: Record<string, any> }> | string;
      raw_message?: string;
    };

    // 提取文本（含非文本段的描述）
    let text = "";
    if (Array.isArray(data.message)) {
      const parts: string[] = [];
      for (const seg of data.message) {
        switch (seg.type) {
          case "text": parts.push(seg.data.text ?? ""); break;
          case "image": parts.push("[图片]"); break;
          case "face": {
            const faceEmoji = QQ_FACE_EMOJI_MAP[String(seg.data.id)];
            parts.push(faceEmoji ?? "[表情]");
            break;
          }
          case "record": parts.push("[语音]"); break;
          case "video": parts.push("[视频]"); break;
          case "file": parts.push(`[文件: ${seg.data.name ?? ""}]`); break;
          case "at": parts.push(`@${seg.data.qq ?? ""}`); break;
          case "forward": parts.push("[转发消息]"); break;
          case "json": parts.push("[卡片]"); break;
          case "reply": break; // 跳过 reply 段
          default: if (seg.type) parts.push(`[${seg.type}]`); break;
        }
      }
      text = parts.join("").trim();
    } else if (typeof data.message === "string") {
      text = data.message;
    } else if (data.raw_message) {
      text = data.raw_message;
    }

    const senderId = data.sender?.user_id ? String(data.sender.user_id) : "";
    const senderName = data.sender?.card || data.sender?.nickname || senderId;

    return { text: text.trim(), senderId, senderName };
  } catch {
    return null;
  }
}

/**
 * 通过 get_login_info API 获取机器人信息（用于 probe）
 */
export async function getLoginInfo(
  client: NapCatWsClient,
): Promise<{ userId: string; nickname: string } | null> {
  try {
    const resp = await client.callApi("get_login_info", {}, 5000);
    if (resp.status !== "ok" || !resp.data) return null;

    const data = resp.data as { user_id?: number; nickname?: string };
    return {
      userId: data.user_id ? String(data.user_id) : "",
      nickname: data.nickname ?? "",
    };
  } catch {
    return null;
  }
}

// ============================================================
// v0.5 新增 API
// ============================================================

/**
 * 撤回消息
 */
export async function deleteMessage(
  client: NapCatWsClient,
  messageId: number | string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("delete_msg", { message_id: Number(messageId) }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 消息表情回应（QQ 表情 ID，非 Unicode emoji）
 * 常用 ID: 76=赞, 63=玫瑰, 66=爱心, 124=OK, 277=汪汪
 */
export async function setMsgEmojiLike(
  client: NapCatWsClient,
  messageId: number | string,
  emojiId: string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("set_msg_emoji_like", {
      message_id: Number(messageId),
      emoji_id: emojiId,
    }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 标记私聊消息已读
 */
export async function markPrivateMsgAsRead(
  client: NapCatWsClient,
  userId: number | string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("mark_private_msg_as_read", {
      user_id: Number(userId),
    }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 标记群聊消息已读
 */
export async function markGroupMsgAsRead(
  client: NapCatWsClient,
  groupId: number | string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("mark_group_msg_as_read", {
      group_id: Number(groupId),
    }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 处理好友请求（同意/拒绝）
 */
export async function setFriendAddRequest(
  client: NapCatWsClient,
  flag: string,
  approve: boolean,
  remark?: string,
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = { flag, approve };
    if (remark) params.remark = remark;
    const resp = await client.callApi("set_friend_add_request", params, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 处理入群请求/邀请（同意/拒绝）
 */
export async function setGroupAddRequest(
  client: NapCatWsClient,
  flag: string,
  subType: string,
  approve: boolean,
  reason?: string,
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = { flag, sub_type: subType, approve };
    if (reason) params.reason = reason;
    const resp = await client.callApi("set_group_add_request", params, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 获取群历史消息
 */
export async function getGroupMsgHistory(
  client: NapCatWsClient,
  groupId: number | string,
  count: number = 20,
  messageSeq?: number,
): Promise<Array<{ message_id: number; user_id: number; nickname: string; content: string; time: number }>> {
  try {
    const params: Record<string, unknown> = {
      group_id: Number(groupId),
      count,
    };
    if (messageSeq !== undefined) params.message_seq = messageSeq;
    const resp = await client.callApi("get_group_msg_history", params, 10000);
    if (resp.status !== "ok" || !resp.data) return [];

    const data = resp.data as { messages?: any[] };
    const messages = data.messages ?? (Array.isArray(resp.data) ? resp.data as any[] : []);
    return messages.map((msg: any) => ({
      message_id: msg.message_id ?? 0,
      user_id: msg.user_id ?? msg.sender?.user_id ?? 0,
      nickname: msg.sender?.card || msg.sender?.nickname || String(msg.user_id ?? ""),
      content: extractTextFromSegments(msg.message),
      time: msg.time ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 获取私聊历史消息
 */
export async function getFriendMsgHistory(
  client: NapCatWsClient,
  userId: number | string,
  count: number = 20,
  messageSeq?: string,
): Promise<Array<{ message_id: number; user_id: number; nickname: string; content: string; time: number }>> {
  try {
    const params: Record<string, unknown> = {
      user_id: Number(userId),
      count,
    };
    if (messageSeq !== undefined) params.message_seq = messageSeq;
    const resp = await client.callApi("get_friend_msg_history", params, 10000);
    if (resp.status !== "ok" || !resp.data) return [];

    const data = resp.data as { messages?: any[] };
    const messages = data.messages ?? (Array.isArray(resp.data) ? resp.data as any[] : []);
    return messages.map((msg: any) => ({
      message_id: msg.message_id ?? 0,
      user_id: msg.user_id ?? msg.sender?.user_id ?? 0,
      nickname: msg.sender?.card || msg.sender?.nickname || String(msg.user_id ?? ""),
      content: extractTextFromSegments(msg.message),
      time: msg.time ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 合并转发消息
 */
export async function sendForwardMsg(
  client: NapCatWsClient,
  opts: {
    chatType: "direct" | "group";
    userId?: string;
    groupId?: string;
    nodes: Array<{ name: string; uin: string; content: OneBotSegment[] }>;
  },
): Promise<SendResult> {
  const messages = opts.nodes.map((node) => ({
    type: "node" as const,
    data: {
      nickname: node.name,
      user_id: node.uin,
      content: node.content,
    },
  }));

  const params: Record<string, unknown> = { messages };

  if (opts.chatType === "group") {
    if (!opts.groupId) return { ok: false, error: "Missing groupId" };
    params.group_id = Number(opts.groupId);
    params.message_type = "group";
  } else {
    if (!opts.userId) return { ok: false, error: "Missing userId" };
    params.user_id = Number(opts.userId);
    params.message_type = "private";
  }

  try {
    const resp = await client.callApi("send_forward_msg", params, 30000);
    if (resp.status === "ok") {
      const data = resp.data as { message_id?: number } | null;
      return { ok: true, messageId: data?.message_id };
    }
    return { ok: false, error: `status=${resp.status} retcode=${resp.retcode}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 上传私聊文件
 */
export async function uploadPrivateFile(
  client: NapCatWsClient,
  userId: number | string,
  filePath: string,
  fileName: string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("upload_private_file", {
      user_id: Number(userId),
      file: filePath,
      name: fileName,
    }, 60000); // 文件上传可能慢，60s 超时
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 上传群文件
 */
export async function uploadGroupFile(
  client: NapCatWsClient,
  groupId: number | string,
  filePath: string,
  fileName: string,
  folderId?: string,
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = {
      group_id: Number(groupId),
      file: filePath,
      name: fileName,
    };
    if (folderId) params.folder_id = folderId;
    const resp = await client.callApi("upload_group_file", params, 60000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/** 从 message segments 提取纯文本（用于历史消息） */
function extractTextFromSegments(message: any): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  const parts: string[] = [];
  for (const seg of message) {
    if (seg.type === "text") parts.push(seg.data?.text ?? "");
    else if (seg.type === "image") parts.push("[图片]");
    else if (seg.type === "face") {
      const emoji = QQ_FACE_EMOJI_MAP[String(seg.data?.id)];
      parts.push(emoji ?? "[表情]");
    }
    else if (seg.type === "at") parts.push(`@${seg.data?.qq ?? ""}`);
    else if (seg.type === "record") parts.push("[语音]");
    else if (seg.type === "video") parts.push("[视频]");
    else if (seg.type === "reply") { /* skip */ }
    else if (seg.type) parts.push(`[${seg.type}]`);
  }
  return parts.join("").trim();
}

/**
 * 获取群成员信息
 */
export async function getGroupMemberInfo(
  client: NapCatWsClient,
  groupId: number | string,
  userId: number | string,
): Promise<{
  user_id: number;
  nickname: string;
  card: string;
  role: string;
  title: string;
  join_time: number;
  last_sent_time: number;
  level: string;
} | null> {
  try {
    const resp = await client.callApi("get_group_member_info", {
      group_id: Number(groupId),
      user_id: Number(userId),
    }, 5000);
    if (resp.status !== "ok" || !resp.data) return null;
    return resp.data as any;
  } catch {
    return null;
  }
}

/**
 * 设置精华消息（pin）
 */
export async function setEssenceMsg(
  client: NapCatWsClient,
  messageId: number | string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("set_essence_msg", { message_id: Number(messageId) }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}

/**
 * 删除精华消息（unpin）
 */
export async function deleteEssenceMsg(
  client: NapCatWsClient,
  messageId: number | string,
): Promise<boolean> {
  try {
    const resp = await client.callApi("delete_essence_msg", { message_id: Number(messageId) }, 5000);
    return resp.status === "ok";
  } catch {
    return false;
  }
}
