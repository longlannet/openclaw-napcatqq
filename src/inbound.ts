// ============================================================
// 入站消息处理 — NapCat 事件 → OpenClaw 标准消息
// 支持 OneBot v11 所有消息段类型
// ============================================================

import type { OneBotMessageEvent, OneBotSegment } from "./types.js";
import { escapeRegExp } from "openclaw/plugin-sdk";

/** QQ 表情 ID → Unicode Emoji 映射（常用部分） */
export const QQ_FACE_EMOJI_MAP: Record<string, string> = {
  "0": "😲", "1": "😖", "2": "😍", "3": "😶", "4": "😎",
  "5": "😭", "6": "☺️", "7": "🤐", "8": "😴", "9": "😢",
  "10": "😤", "11": "😊", "12": "😜", "13": "😁", "14": "🙂",
  "15": "😡", "16": "🤗", "18": "😱", "19": "🤮", "20": "🤭",
  "21": "😊", "22": "😌", "23": "😕", "24": "🤤", "25": "😂",
  "26": "😅", "27": "😒", "28": "😘", "29": "😚", "30": "🔪",
  "31": "🍺", "32": "😩", "33": "😓", "34": "😀", "35": "🥺",
  "46": "🐷", "49": "🤡", "53": "🎂", "54": "⚡", "55": "💣",
  "56": "🔪", "57": "⚽", "59": "💩", "60": "☕", "63": "🌹",
  "64": "🥀", "66": "❤️", "67": "💔", "69": "🎁", "74": "🌞",
  "75": "🌙", "76": "👍", "77": "👎", "78": "🤝", "79": "✌️",
  "85": "😷", "86": "😣", "96": "😰", "97": "😥", "98": "😨",
  "99": "😫", "100": "😤", "101": "😈", "102": "💀", "103": "🏁",
  "104": "🏀", "105": "🏓", "106": "❤️", "107": "🐛", "108": "🐔",
  "109": "🐶", "110": "👏", "111": "💪", "112": "🤞", "113": "🖕",
  "114": "💃", "115": "🤦", "116": "🙇", "117": "🤷", "118": "💆",
  "120": "✊", "121": "🤟", "122": "🤘", "123": "🤙", "124": "👌",
  "125": "👈", "126": "👉", "127": "👆", "128": "👇", "129": "🙏",
  "144": "🍉", "147": "🍭", "171": "🍵", "172": "😿", "173": "🐱",
  "174": "🐻", "176": "🐲", "177": "🎉", "178": "🎊", "179": "🎈",
  "182": "💊", "183": "🔫", "200": "🐑", "201": "🎄", "202": "🎎",
  "203": "💝", "204": "🏠", "212": "😄", "214": "🤩",
  "277": "🐕", "307": "🌈", "312": "🤳", "318": "💅", "319": "🤠",
  "320": "😇", "322": "😴", "325": "🤮",
};

/** 把字节数字符串转为可读格式 */
function formatFileSize(sizeStr: string): string {
  const bytes = Number(sizeStr);
  if (!Number.isFinite(bytes) || bytes < 0) return sizeStr;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface NormalizedInbound {
  chatId: string;           // "napcatqq:<qq号>" 或 "napcatqq:g<群号>"
  chatType: "direct" | "group";
  senderId: string;         // QQ 号
  senderName: string;       // 昵称或群名片
  text: string;             // 纯文本内容（含非文本段的描述）
  messageId: string;        // 消息 ID
  replyToMessageId?: string; // 引用的消息 ID
  imageUrls: string[];       // 图片 URL 列表
  audioUrls: string[];       // 语音 URL 列表
  videoUrls: string[];       // 视频 URL 列表
  fileInfos: Array<{ name: string; url?: string; fileId?: string; size?: string }>; // 文件信息
  mentions: string[];        // 被 @ 的 QQ 号列表
  mentionsAll: boolean;      // 是否 @全体
  groupId?: string;          // 群号（群聊时）
  raw: OneBotMessageEvent;   // 原始事件
}

/**
 * 将 OneBot 消息事件标准化为 OpenClaw 可用结构
 * 支持 Array（segment 格式）和 String（CQ码/纯文本）两种模式
 */
export function normalizeInbound(event: OneBotMessageEvent): NormalizedInbound {
  const isGroup = event.message_type === "group";
  const chatId = isGroup
    ? `napcatqq:g${event.group_id}`
    : `napcatqq:${event.user_id}`;

  const rawMessage = event.message;

  // NapCat 的 message 字段可能是 Array 或 String
  const segments: OneBotSegment[] = Array.isArray(rawMessage) ? rawMessage : [];
  const fallbackText = typeof rawMessage === "string" ? rawMessage : (event.raw_message ?? "");

  // 提取结果
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const audioUrls: string[] = [];
  const videoUrls: string[] = [];
  const fileInfos: Array<{ name: string; url?: string; fileId?: string; size?: string }> = [];
  const mentions: string[] = [];
  let mentionsAll = false;
  let replyToMessageId: string | undefined;

  if (segments.length > 0) {
    for (const seg of segments) {
      switch (seg.type) {
        // ---- 文本类 ----
        case "text":
          textParts.push(seg.data.text);
          break;

        case "markdown":
          textParts.push(seg.data.content);
          break;

        // ---- 提及类 ----
        case "at":
          if (seg.data.qq === "all") {
            mentionsAll = true;
          } else {
            mentions.push(String(seg.data.qq));
          }
          break;

        // ---- 引用回复 ----
        case "reply":
          if (seg.data.id) replyToMessageId = seg.data.id;
          break;

        // ---- 媒体类 ----
        case "image": {
          const url = seg.data.url || seg.data.file;
          if (url) imageUrls.push(url);
          textParts.push(seg.data.summary ? `[图片: ${seg.data.summary}]` : "[图片]");
          break;
        }

        case "record": {
          const url = seg.data.url || seg.data.file;
          if (url) audioUrls.push(url);
          textParts.push("[语音消息]");
          break;
        }

        case "video": {
          const url = seg.data.url || seg.data.file;
          if (url) videoUrls.push(url);
          textParts.push("[视频消息]");
          break;
        }

        case "file": {
          const name = seg.data.name || seg.data.file || "未知文件";
          const fileId = seg.data.file_id || undefined;
          fileInfos.push({ name, url: seg.data.url, fileId });
          textParts.push(`[文件: ${name}]`);
          break;
        }

        case "onlinefile": {
          fileInfos.push({
            name: seg.data.fileName,
            size: seg.data.fileSize,
          });
          textParts.push(`[文件: ${seg.data.fileName} (${formatFileSize(seg.data.fileSize)})]`);
          break;
        }

        // ---- 表情类 ----
        case "face": {
          const emoji = QQ_FACE_EMOJI_MAP[String(seg.data.id)];
          textParts.push(emoji ?? `[QQ表情:${seg.data.id}]`);
          break;
        }

        case "mface":
          // 商城表情有 summary 如 "[开心]"
          textParts.push(seg.data.summary || "[商城表情]");
          break;

        // ---- 互动类 ----
        case "poke":
          textParts.push("[戳一戳]");
          break;

        case "dice":
          textParts.push(`[骰子: ${seg.data.result}]`);
          break;

        case "rps": {
          const rpsMap: Record<string, string> = { "1": "石头", "2": "剪刀", "3": "布" };
          textParts.push(`[猜拳: ${rpsMap[String(seg.data.result)] || seg.data.result}]`);
          break;
        }

        // ---- 富媒体类 ----
        case "json": {
          // 尝试提取 JSON 卡片的摘要
          let summary = "[JSON卡片]";
          try {
            const jsonData = typeof seg.data.data === "string" ? JSON.parse(seg.data.data) : seg.data.data;
            const desc = jsonData?.meta?.detail_1?.desc || jsonData?.meta?.news?.desc || jsonData?.prompt;
            if (desc) summary = `[卡片: ${desc}]`;
          } catch { /* 解析失败用默认 */ }
          textParts.push(summary);
          break;
        }

        case "xml":
          textParts.push("[XML消息]");
          break;

        case "miniapp":
          textParts.push("[小程序消息]");
          break;

        // ---- 位置 ----
        case "location":
          textParts.push(
            `[位置: ${seg.data.title || ""}${seg.data.content ? " " + seg.data.content : ""} (${seg.data.lat}, ${seg.data.lon})]`
          );
          break;

        // ---- 音乐 ----
        case "music":
          textParts.push(`[音乐: ${seg.data.title || seg.data.type}]`);
          break;

        // ---- 联系人 ----
        case "contact":
          textParts.push(`[联系人: ${seg.data.type === "group" ? "群" : "QQ"}${seg.data.id}]`);
          break;

        // ---- 合并转发 ----
        case "forward": {
          textParts.push("[合并转发消息]");
          if (seg.data.content && Array.isArray(seg.data.content)) {
            const forwardMessages = seg.data.content as Array<any>;
            for (const fMsg of forwardMessages.slice(0, 5)) {
              const sender = fMsg.sender?.nickname || fMsg.sender?.card || String(fMsg.user_id ?? "");
              const msgSegs = Array.isArray(fMsg.message) ? fMsg.message : [];
              const fParts: string[] = [];
              for (const fSeg of msgSegs) {
                if (fSeg.type === "text") fParts.push(fSeg.data?.text ?? "");
                else if (fSeg.type === "image") fParts.push("[图片]");
                else if (fSeg.type === "face") {
                  const fEmoji = QQ_FACE_EMOJI_MAP[String(fSeg.data?.id)];
                  fParts.push(fEmoji ?? "[表情]");
                }
                else if (fSeg.type) fParts.push(`[${fSeg.type}]`);
              }
              const fText = fParts.join("").trim();
              if (fText) textParts.push(`  ${sender}: ${fText}`);
            }
            if (forwardMessages.length > 5) {
              textParts.push(`  ...还有${forwardMessages.length - 5}条消息`);
            }
          }
          break;
        }

        case "node":
          // 转发节点在 segment 解析层面忽略
          break;

        case "flashtransfer":
          textParts.push("[闪传文件]");
          break;

        // ---- 未知类型 ----
        default:
          textParts.push(`[${(seg as any).type || "未知消息"}]`);
          break;
      }
    }
  } else if (fallbackText) {
    // String 模式：解析 CQ 码中的结构化信息
    const cqPattern = /\[CQ:(\w+)((?:,[^,\]]+)*)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = cqPattern.exec(fallbackText)) !== null) {
      if (match.index > lastIndex) {
        textParts.push(fallbackText.slice(lastIndex, match.index));
      }
      lastIndex = match.index + match[0].length;

      const cqType = match[1];
      const cqParams = match[2];
      const paramMap: Record<string, string> = {};
      for (const kv of cqParams.split(",").filter(Boolean)) {
        const eq = kv.indexOf("=");
        if (eq > 0) paramMap[kv.slice(0, eq)] = kv.slice(eq + 1);
      }

      switch (cqType) {
        case "at":
          if (paramMap.qq === "all") mentionsAll = true;
          else if (paramMap.qq) mentions.push(paramMap.qq);
          break;
        case "image":
          if (paramMap.url) imageUrls.push(paramMap.url);
          else if (paramMap.file) imageUrls.push(paramMap.file);
          textParts.push("[图片]");
          break;
        case "record":
          if (paramMap.url) audioUrls.push(paramMap.url);
          textParts.push("[语音消息]");
          break;
        case "video":
          if (paramMap.url) videoUrls.push(paramMap.url);
          textParts.push("[视频消息]");
          break;
        case "file": {
          const fname = paramMap.name || paramMap.file || "未知文件";
          const fileId = paramMap.file_id || undefined;
          if (paramMap.url) fileInfos.push({ name: fname, url: paramMap.url, fileId });
          else fileInfos.push({ name: fname, fileId });
          textParts.push(`[文件: ${fname}]`);
          break;
        }
        case "reply":
          if (paramMap.id) replyToMessageId = paramMap.id;
          break;
        case "face": {
          const faceEmoji = QQ_FACE_EMOJI_MAP[paramMap.id ?? ""];
          textParts.push(faceEmoji ?? `[QQ表情:${paramMap.id || "?"}]`);
          break;
        }
        default:
          textParts.push(`[${cqType}]`);
          break;
      }
    }
    // 尾部纯文本
    if (lastIndex < fallbackText.length) {
      textParts.push(fallbackText.slice(lastIndex));
    }
  }

  return {
    chatId,
    chatType: isGroup ? "group" : "direct",
    senderId: String(event.user_id),
    senderName: event.sender?.card || event.sender?.nickname || String(event.user_id),
    text: textParts.join("").trim(),
    messageId: String(event.message_id),
    replyToMessageId,
    imageUrls,
    audioUrls,
    videoUrls,
    fileInfos,
    mentions,
    mentionsAll,
    groupId: isGroup ? String(event.group_id) : undefined,
    raw: event,
  };
}

/**
 * 检查消息是否 @ 了机器人
 */
export function isMentioningBot(inbound: NormalizedInbound, selfId: string): boolean {
  if (!selfId) return inbound.mentionsAll;
  return inbound.mentions.includes(selfId) || inbound.mentionsAll;
}

/**
 * 去掉消息文本中的 @机器人 部分，保留纯净内容
 */
export function stripBotMention(text: string, selfId: string): string {
  if (!selfId) return text;
  const escaped = escapeRegExp(selfId);
  return text.replace(new RegExp("@" + escaped + "\s*", "g"), "").trim();
}
