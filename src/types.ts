// ============================================================
// NapCatQQ 事件 & API 类型定义（OneBot v11 / NapCat 4.x）
// 基于 NapCat OpenAPI 文档 v4.17.25
// ============================================================

// ---------- FileBaseData（图片/语音/视频/文件共用） ----------
export interface FileBaseData {
  file: string;      // 文件路径/URL/file:///
  path?: string;     // 文件路径
  url?: string;      // 文件 URL
  name?: string;     // 文件名
  thumb?: string;    // 缩略图
  file_id?: string;  // 文件ID（NapCatQQ 私有扩展）
}

// ---------- 消息段类型 ----------

export interface OneBotTextSegment {
  type: "text";
  data: { text: string };
}

export interface OneBotFaceSegment {
  type: "face";
  data: { id: string; resultId?: string; chainCount?: number };
}

export interface OneBotMFaceSegment {
  type: "mface";
  data: {
    emoji_package_id: number;
    emoji_id: string;
    key: string;
    summary: string;  // 表情摘要，如 "[开心]"
  };
}

export interface OneBotAtSegment {
  type: "at";
  data: { qq: string | number | "all"; name?: string };
}

export interface OneBotReplySegment {
  type: "reply";
  data: { id?: string; seq?: number };
}

export interface OneBotImageSegment {
  type: "image";
  data: FileBaseData & { summary?: string; sub_type?: number };
}

export interface OneBotRecordSegment {
  type: "record";
  data: FileBaseData;
}

export interface OneBotVideoSegment {
  type: "video";
  data: FileBaseData;
}

export interface OneBotFileSegment {
  type: "file";
  data: FileBaseData;
}

export interface OneBotJsonSegment {
  type: "json";
  data: { data: string | Record<string, unknown> };
}

export interface OneBotXmlSegment {
  type: "xml";
  data: { data: string };
}

export interface OneBotForwardSegment {
  type: "forward";
  data: { id: string; content?: unknown };
}

export interface OneBotLocationSegment {
  type: "location";
  data: { lat: string | number; lon: string | number; title?: string; content?: string };
}

export interface OneBotPokeSegment {
  type: "poke";
  data: { type: string; id: string };
}

export interface OneBotDiceSegment {
  type: "dice";
  data: { result: number | string };
}

export interface OneBotRPSSegment {
  type: "rps";
  data: { result: number | string };
}

export interface OneBotMusicSegment {
  type: "music";
  data: {
    type: "qq" | "163" | "kugou" | "migu" | "kuwo" | "custom";
    id?: string | number;
    url?: string;
    audio?: string;
    title?: string;
    image?: string;
    content?: string;
  };
}

export interface OneBotContactSegment {
  type: "contact";
  data: { type: "qq" | "group"; id: string };
}

export interface OneBotMarkdownSegment {
  type: "markdown";
  data: { content: string };
}

export interface OneBotMiniAppSegment {
  type: "miniapp";
  data: { data: string };
}

export interface OneBotNodeSegment {
  type: "node";
  data: {
    id?: string;
    user_id?: number | string;
    nickname?: string;
    content?: unknown;
  };
}

export interface OneBotOnlineFileSegment {
  type: "onlinefile";
  data: {
    msgId: string;
    elementId: string;
    fileName: string;
    fileSize: string;
    isDir: boolean;
  };
}

export interface OneBotFlashTransferSegment {
  type: "flashtransfer";
  data: { fileSetId: string };
}

export type OneBotSegment =
  | OneBotTextSegment
  | OneBotFaceSegment
  | OneBotMFaceSegment
  | OneBotAtSegment
  | OneBotReplySegment
  | OneBotImageSegment
  | OneBotRecordSegment
  | OneBotVideoSegment
  | OneBotFileSegment
  | OneBotJsonSegment
  | OneBotXmlSegment
  | OneBotForwardSegment
  | OneBotLocationSegment
  | OneBotPokeSegment
  | OneBotDiceSegment
  | OneBotRPSSegment
  | OneBotMusicSegment
  | OneBotContactSegment
  | OneBotMarkdownSegment
  | OneBotMiniAppSegment
  | OneBotNodeSegment
  | OneBotOnlineFileSegment
  | OneBotFlashTransferSegment;

// ---------- 消息事件 ----------
export interface OneBotMessageEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  message_seq?: number;
  user_id: number;
  group_id?: number;
  group_name?: string;
  message: OneBotSegment[] | string;  // Array 或 String（CQ码/纯文本）
  message_format?: "array" | "string";
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;       // 群名片
    role?: "owner" | "admin" | "member";
    sex?: string;
    age?: number;
  };
  self_id: number;
  time: number;
}

// ---------- 元事件（心跳/生命周期） ----------
export interface OneBotMetaEvent {
  post_type: "meta_event";
  meta_event_type: "heartbeat" | "lifecycle";
  sub_type?: string;
  self_id: number;
  time: number;
}

// ---------- 通知事件 ----------
export interface OneBotNoticeEvent {
  post_type: "notice";
  notice_type: string;
  sub_type?: string;
  self_id: number;
  time: number;
  group_id?: number;
  user_id?: number;
  operator_id?: number;
  [key: string]: unknown;
}

// ---------- 请求事件 ----------
export interface OneBotRequestEvent {
  post_type: "request";
  request_type: "friend" | "group";
  sub_type?: string;          // group: "add" | "invite"
  user_id: number;
  group_id?: number;
  comment?: string;           // 验证消息
  flag: string;               // 请求标识（用于同意/拒绝）
  self_id: number;
  time: number;
}

// ---------- 机器人自发消息事件 ----------
export interface OneBotMessageSentEvent {
  post_type: "message_sent";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: OneBotSegment[] | string;
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
  };
  self_id: number;
  time: number;
  target_id?: number;         // 私聊目标 QQ 号
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | OneBotNoticeEvent | OneBotRequestEvent | OneBotMessageSentEvent;

// ---------- API 调用 ----------
export interface OneBotApiRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

export interface OneBotApiResponse {
  status: "ok" | "failed";
  retcode: number;
  data: unknown;
  echo?: string;
}

// ---------- 插件账号配置 ----------
export interface NapCatAccountConfig {
  accountId: string;
  enabled: boolean;
  wsUrl: string;              // e.g. "wss://ncqw.ma.al"
  accessToken?: string;       // OneBot access_token
  selfId?: string;            // 机器人 QQ 号（连接后自动获取）
  requireMention?: boolean;   // 群聊是否需要 @ 才响应
  commandPrefix?: string;     // 命令前缀，默认 "/"
  allowFrom?: Array<string | number>;
  groupPolicy?: "disabled" | "open" | "allowlist" | "pairing";
  groupAllowFrom?: Array<string | number>;
  historyLimit?: number;
  dm?: {
    policy?: string;
    allowFrom?: Array<string | number>;
  };
  // ── v0.5 新增 ──
  autoAcceptFriend?: boolean;       // 自动同意好友请求（默认 false）
  autoAcceptGroupInvite?: boolean;  // 自动同意入群邀请（默认 false）
  emojiAck?: boolean;               // 收到消息时打表情回应（默认 false）
}
