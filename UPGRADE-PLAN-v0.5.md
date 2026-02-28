# NapCatQQ 插件 v0.5 升级计划

> 基于 NapCat 官方文档全面研究（2026-02-28）
> 文档站点：https://napneko.github.io/

---

## 一、当前已用的 API

| API | 用途 |
|-----|------|
| `send_private_msg` / `send_group_msg` | 收发消息 |
| `get_msg` | 引用回复上下文 |
| `get_login_info` | Bot probe |
| `get_friend_list` | 联系人目录 |
| `get_group_list` | 群列表目录 |
| `set_input_status` | Typing 状态（仅私聊） |
| `meta_event.heartbeat` | WebSocket 连接检测 |
| 消息段全量解析 | 23 种消息类型 |

---

## 二、高价值新增（必做）

### ~~1. `get_record` — 语音转码后下载~~
~~已验证 QQ 语音实际收到的是 AMR 格式，当前 provider 直接支持，无需转码。~~
**跳过。** 如果将来换 provider 不支持 AMR（如 OpenAI Whisper），再加回来。

### 2. `set_msg_emoji_like` — 消息表情回应
实现 ack reaction（收到消息后先打个表情），对应 SDK 的 `shouldAckReaction`。

```json
{
  "action": "set_msg_emoji_like",
  "params": {
    "message_id": 123456,
    "emoji_id": "76"        // QQ 表情 ID
  }
}
```

### 3. `delete_msg` — 撤回消息
开启 unsend 能力，可以撤回机器人发的错误消息。

```json
{
  "action": "delete_msg",
  "params": {
    "message_id": 123456
  }
}
```

### 4. `get_group_msg_history` — 群聊消息历史
启动时加载最近消息作为上下文，比只靠运行时缓存更完整。

```json
{
  "action": "get_group_msg_history",
  "params": {
    "group_id": 712545,
    "message_seq": "0",     // 起始消息序号，默认 0
    "count": 20,            // 数量，默认 20
    "reverseOrder": false   // 倒序，默认 false
  }
}
```

### 5. `get_friend_msg_history` — 私聊消息历史

```json
{
  "action": "get_friend_msg_history",
  "params": {
    "user_id": "972708",
    "message_seq": "0",
    "count": 20,
    "reverseOrder": false
  }
}
```

### 6. `mark_private_msg_as_read` / `mark_group_msg_as_read` — 标记已读
处理完消息后标记已读，更自然。

```json
// 私聊
{ "action": "mark_private_msg_as_read", "params": { "user_id": 972708 } }

// 群聊
{ "action": "mark_group_msg_as_read", "params": { "group_id": 712545 } }
```

---

## 三、中等价值新增

### 7. `get_stranger_info` — 获取陌生人信息
pairing 时显示更详细的用户资料（昵称、年龄、性别等）。

```json
{
  "action": "get_stranger_info",
  "params": { "user_id": 123456 }
}
```

### 8. `get_group_member_info` — 获取群成员信息
群聊上下文可以包含成员角色（owner/admin/member）。

```json
{
  "action": "get_group_member_info",
  "params": { "group_id": 712545, "user_id": 123456 }
}
```

### 9. `send_forward_msg` — 合并转发
长回复打包成转发消息，避免刷屏。

```json
{
  "action": "send_forward_msg",
  "params": {
    "message_type": "group",   // 或 "private"
    "group_id": 712545,        // 或 "user_id"
    "messages": [
      {
        "type": "node",
        "data": {
          "user_id": "16970392",
          "nickname": "小龙",
          "content": [{ "type": "text", "data": { "text": "第一段" } }]
        }
      },
      {
        "type": "node",
        "data": {
          "user_id": "16970392",
          "nickname": "小龙",
          "content": [{ "type": "text", "data": { "text": "第二段" } }]
        }
      }
    ]
  }
}
```

### 10. `upload_private_file` / `upload_group_file` — 文件发送
Agent 生成的文件可以直接发到 QQ。视频最大 100MB。

### 11. `get_ai_record` / `send_group_ai_record` — QQ AI 语音
用 QQ 内置的 AI 语音角色回复。需要先 `get_ai_characters` 获取角色列表。

### 12. `friend_poke` / `group_poke` — 戳一戳

```json
// 私聊戳一戳
{ "action": "friend_poke", "params": { "user_id": 972708 } }

// 群聊戳一戳
{ "action": "group_poke", "params": { "group_id": 712545, "user_id": 972708 } }
```

---

## 四、低价值但有趣

| API | 能力 | 备注 |
|-----|------|------|
| `set_group_card` | 修改机器人群名片 | 可以按群设置不同名字 |
| `send_like` | 给用户点赞 | 注意调用频率限制 |
| `ocr_image` | 图片 OCR | PacketBackend 高性能 OCR |
| `translate_en2zh` | 英译中 | `words: string[]` → `string[]` |
| `set_qq_avatar` | 设置机器人头像 | `file: string`（路径或链接） |
| `get_mini_app_ark` | 签名小程序卡片 | 如 B站分享卡片 |
| `set_online_status` | 设置在线状态 | 30+ 种：在线/忙碌/摸鱼中/搬砖中等 |

### 在线状态码速查

| 状态 | status | extStatus |
|------|--------|-----------|
| 在线 | 10 | 0 |
| 忙碌 | 50 | 0 |
| 离开 | 30 | 0 |
| 隐身 | 40 | 0 |
| 请勿打扰 | 70 | 0 |
| 听歌中 | 10 | 1028 |
| 摸鱼中 | 10 | 1300 |
| 搬砖中 | 10 | 2023 |
| 学习中 | 10 | 1018 |
| 睡觉中 | 10 | 1016 |
| 追剧中 | 10 | 1021 |

---

## 五、Notice 事件处理（当前完全未处理！）

当前 `onEvent` 对 `post_type === "notice"` 直接 `return`。以下事件值得处理：

| 事件 | 用途 | 优先级 |
|------|------|--------|
| `notice.group_increase` | 新成员入群 → 自动欢迎/检查 pairing | ⭐⭐⭐ |
| `notice.group_decrease.kick_me` | 机器人被踢 → 自动从 groupAllowFrom 移除 | ⭐⭐⭐ |
| `notice.friend_add` | 新好友添加 → 触发欢迎或自动 pairing | ⭐⭐⭐ |
| `notice.group_recall` | 群消息撤回 → 日志记录 | ⭐⭐ |
| `notice.friend_recall` | 私聊消息撤回 → 日志记录 | ⭐⭐ |
| `notice.group_admin` | 管理员变动 → 更新角色缓存 | ⭐⭐ |
| `notice.group_ban` | 禁言通知 → 机器人被禁言告警 | ⭐⭐ |
| `notice.notify.poke` | 戳一戳事件 → 趣味回复 | ⭐ |
| `notice.group_upload` | 群文件上传 → 通知 Agent | ⭐ |
| `notice.group_msg_emoji_like` | 表情回应通知 → 仅收自己消息的回应 | ⭐ |

### Notice 事件数据结构

```typescript
// 群成员增加
{ post_type: "notice", notice_type: "group_increase", group_id: number, user_id: number, operator_id: number, sub_type: "approve" | "invite" }

// 机器人被踢
{ post_type: "notice", notice_type: "group_decrease", group_id: number, user_id: number, operator_id: number, sub_type: "kick_me" }

// 新好友
{ post_type: "notice", notice_type: "friend_add", user_id: number }

// 群消息撤回
{ post_type: "notice", notice_type: "group_recall", group_id: number, user_id: number, operator_id: number, message_id: number }

// 私聊消息撤回
{ post_type: "notice", notice_type: "friend_recall", user_id: number, message_id: number }

// 管理员变动
{ post_type: "notice", notice_type: "group_admin", group_id: number, user_id: number, sub_type: "set" | "unset" }

// 禁言
{ post_type: "notice", notice_type: "group_ban", group_id: number, user_id: number, operator_id: number, duration: number, sub_type: "ban" | "lift_ban" }

// 戳一戳
{ post_type: "notice", notice_type: "notify", sub_type: "poke", group_id?: number, user_id: number, target_id: number }
```

---

## 六、Request 事件自动处理

当前完全未处理。可以实现好友/群申请自动审批。

| 事件 | 处理 API | 用途 |
|------|----------|------|
| `request.friend` | `set_friend_add_request` | 自动同意/拒绝好友请求 |
| `request.group.add` | `set_group_add_request` | 自动审批加群请求 |
| `request.group.invite` | `set_group_add_request` | 自动同意邀请入群 |

```typescript
// 好友请求事件
{ post_type: "request", request_type: "friend", user_id: number, comment: string, flag: string }

// 处理
{ action: "set_friend_add_request", params: { flag: "xxx", approve: true, remark: "备注" } }

// 加群请求
{ post_type: "request", request_type: "group", sub_type: "add" | "invite", group_id: number, user_id: number, comment: string, flag: string }

// 处理
{ action: "set_group_add_request", params: { flag: "xxx", sub_type: "add", approve: true, reason: "理由" } }
```

---

## 七、其他可用事件

| 事件 | 用途 |
|------|------|
| `message_sent` | 记录机器人自己发的消息到历史，保持上下文完整 |
| `meta_event.lifecycle.connect` | WebSocket 连接成功（已处理） |

---

## 八、重要技术发现

### 图片 URL 约 2 小时过期
我们下载到内存的策略是正确的。过期后的补救措施：
- `nc_get_rkey` — 获取新 rkey 替换 URL 中的 rkey
- `get_image` / `get_file` / `get_msg` — 刷新获取新 URL

### 音频是 raw silk 格式
NapCat 内置 silk/ffmpeg 转码。接收时可以用 `get_record` 转成 mp3；发送时 NapCat 自动转成 silk。v4.4.11 后无需手动配置 FFmpeg。

### Stream API（v4.8.115+）
新的流式文件传输 API，适合大文件（>100MB）和跨设备部署。目前用不上，后续文件发送功能可能需要。

### PacketBackend Native（v3.6.0+）
内置 DLC，无需额外配置。支持：群头衔、poke、独立 Rkey、伪造合并转发、Markdown、AI 语音、高性能 OCR。

### 安全事件（2025.9.5）
大量空 Token 的 NapCat 实例被扫描攻击。我们已做对：Token 通过 `Authorization: Bearer` Header 传递。README 可以加安全建议。

---

## 九、代码结构优化

1. **拆分 channel.ts**（当前 1682 行）→ 参考官方插件拆成多个模块
2. **添加单元测试** → 重点测试 inbound 解析、access control、CQ 码解析

---

## 十、实施优先级

### 第一批（投入小、收益大）
- [ ] `get_record` 语音转码
- [ ] `set_msg_emoji_like` 表情回应
- [ ] `delete_msg` 撤回消息
- [ ] `mark_msg_as_read` 标记已读
- [ ] Notice: `group_decrease.kick_me` 被踢自动移除
- [ ] Notice: `friend_add` 新好友欢迎

### 第二批（中等工作量）
- [ ] `get_group_msg_history` / `get_friend_msg_history` 历史消息
- [ ] Request 事件自动审批（好友/群）
- [ ] Notice: `group_increase` 入群欢迎
- [ ] Notice: `group_ban` 禁言告警
- [ ] `message_sent` 记录自发消息

### 第三批（锦上添花）
- [ ] `send_forward_msg` 合并转发
- [ ] `friend_poke` / `group_poke` 戳一戳
- [ ] `set_online_status` 动态在线状态
- [ ] `get_stranger_info` / `get_group_member_info` 详细用户信息
- [ ] 文件发送 / AI 语音 / OCR 等
