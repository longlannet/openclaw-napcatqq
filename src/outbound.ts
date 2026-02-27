// ============================================================
// 出站消息处理 — OpenClaw 回复 → NapCat API 调用
// ============================================================

import type { NapCatWsClient } from "./ws-client.js";
import type { OneBotSegment } from "./types.js";

export interface SendOptions {
  chatType: "direct" | "group";
  userId?: string;
  groupId?: string;
  text?: string;
  imageUrl?: string;          // 图片 URL 或 base64
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
    segments.push({
      type: "image",
      data: { file: opts.imageUrl },
    });
  }

  if (segments.length === 0) {
    return { ok: false, error: "Nothing to send (no text, image, or reply)" };
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
          case "face": parts.push(`[表情]`); break;
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
