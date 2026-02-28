// ============================================================
// NapCatQQ 配置 Schema（控制面板渲染用）
// ============================================================

import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

export const configSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    properties: {
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            // ── 连接 ──
            enabled: { type: "boolean" },
            wsUrl: { type: "string", format: "uri" },
            accessToken: { type: "string" },
            selfId: { type: "string" },
            // ── 管理 ──
            allowFrom: {
              type: "array",
              items: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
            commandPrefix: { type: "string" },
            defaultTo: { type: "string" },
            // ── 私聊 ──
            dm: {
              type: "object",
              properties: {
                policy: {
                  type: "string",
                  enum: ["pairing", "open", "closed"],
                },
                allowFrom: {
                  type: "array",
                  items: { oneOf: [{ type: "string" }, { type: "number" }] },
                },
              },
            },
            // ── 群聊 ──
            groupPolicy: {
              type: "string",
              enum: ["disabled", "open", "allowlist", "pairing"],
            },
            requireMention: { type: "boolean" },
            groupAllowFrom: {
              type: "array",
              items: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
            historyLimit: { type: "number" },
            // ── v0.5 新增 ──
            autoAcceptFriend: { type: "boolean" },
            autoAcceptGroupInvite: { type: "boolean" },
            emojiAck: { type: "boolean" },
          },
          required: ["wsUrl"],
        },
      },
    },
  },
  uiHints: {
    // ── 连接 ──
    "accounts.*.wsUrl": {
      label: "NapCat WebSocket 地址",
      placeholder: "wss://ncqw.example.com",
      help: "NapCat 正向 WebSocket 地址（支持 ws:// 和 wss://）",
    },
    "accounts.*.accessToken": {
      label: "访问令牌",
      sensitive: true,
      help: "OneBot access_token，留空表示无需认证",
    },
    "accounts.*.selfId": {
      label: "机器人 QQ 号",
      help: "连接成功后自动获取，无需手动填写",
    },
    // ── 管理 ──
    "accounts.*.allowFrom": {
      label: "管理员 QQ 号",
      help: "拥有命令权限和审批权限的 QQ 号列表",
    },
    "accounts.*.commandPrefix": {
      label: "命令前缀",
      placeholder: "/",
    },
    "accounts.*.defaultTo": {
      label: "默认发送目标",
      help: "QQ号 或 g群号（message 工具省略 target 时使用）",
    },
    // ── 私聊 ──
    "accounts.*.dm": {
      label: "私聊设置",
    },
    "accounts.*.dm.policy": {
      label: "私聊访问策略",
      help: "pairing = 需管理员审批 | open = 所有人可私聊 | closed = 关闭私聊",
    },
    "accounts.*.dm.allowFrom": {
      label: "已批准的私聊用户",
      help: "已通过审批的用户 QQ 号（自动维护，也可手动添加）",
    },
    // ── 群聊 ──
    "accounts.*.groupPolicy": {
      label: "群聊访问策略",
      help: "disabled = 不响应 | open = 所有群（需@）| allowlist = 仅白名单 | pairing = 新群需审批",
    },
    "accounts.*.requireMention": {
      label: "群聊需要 @ 才响应",
      help: "开启后机器人只响应被 @ 的消息（推荐大群开启）",
    },
    "accounts.*.groupAllowFrom": {
      label: "已批准的群",
      help: "已通过审批的群号列表（格式: g群号，自动维护）",
    },
    "accounts.*.historyLimit": {
      label: "群聊历史上下文条数",
      help: "群聊中未触发的消息缓存条数，作为上下文提供给 Agent，默认 50",
    },
    // ── v0.5 新增 ──
    "accounts.*.autoAcceptFriend": {
      label: "自动同意好友请求",
      help: "开启后机器人会自动同意所有好友请求（默认关闭）",
    },
    "accounts.*.autoAcceptGroupInvite": {
      label: "自动同意入群邀请",
      help: "开启后机器人被邀请入群时自动同意（默认关闭）",
    },
    "accounts.*.emojiAck": {
      label: "消息表情回应",
      help: "收到消息时自动打表情（处理中 → 完成），默认关闭",
    },
  },
};
