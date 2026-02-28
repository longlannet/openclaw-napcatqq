# openclaw-napcatqq 未实现功能清单

> 最后更新: 2026-02-28 v0.6  
> 用途: 未来版本升级参考，按优先级和分类整理

---

## 一、Actions（Agent 主动操作能力）

当前已实现 10 个: `unsend, delete, react, send, sendAttachment, read, reply, member-info, pin, unpin`

### 群管理类

| Action | NapCat API | 说明 | 难度 |
|--------|-----------|------|------|
| `kick` | `set_group_kick` | 踢出群成员。参数: `group_id`, `user_id`, `reject_add_request`(是否拒绝再次加群) | 低 |
| `ban` | `set_group_ban` | 禁言指定成员。参数: `group_id`, `user_id`, `duration`(秒，0=解禁) | 低 |
| `ban-all` | `set_group_whole_ban` | 全体禁言/解禁。参数: `group_id`, `enable` | 低 |
| `leaveGroup` | `set_group_leave` | 机器人主动退群。参数: `group_id`, `is_dismiss`(群主解散) | 低 |
| `renameGroup` | `set_group_name` | 修改群名。参数: `group_id`, `group_name` | 低 |
| `setGroupCard` | `set_group_card` | 修改群成员名片。参数: `group_id`, `user_id`, `card` | 低 |
| `setGroupAdmin` | `set_group_admin` | 设置/取消管理员。参数: `group_id`, `user_id`, `enable` | 低 |
| `addParticipant` | 无直接 API | QQ 群拉人需要好友关系，且无可靠 API | 不可行 |

### 消息类

| Action | NapCat API | 说明 | 难度 |
|--------|-----------|------|------|
| `sticker` | `send_msg` + `mface` 段 | 发送商城表情。需要 `emoji_package_id`, `emoji_id`, `key`, `summary` — Agent 难以获取这些参数 | 中 |
| `at` | `send_msg` + `at` 段 | 群聊中 @指定人。`reply` 段已自带 @效果，实际需求不大 | 低 |
| `music` | `send_msg` + `music` 段 | 发送音乐卡片。支持 QQ音乐/网易云/酷狗/自定义。Agent 主动发音乐的场景极少 | 低 |
| `poke` | `send_msg` + `poke` 段 | 发送戳一戳 | 低 |

### QQ 协议不支持（永久跳过）

| Action | 原因 |
|--------|------|
| `edit` | QQ 协议不支持编辑已发送消息 |
| `poll` | QQ 无原生投票功能 |
| `search` | QQ/NapCat 无消息搜索 API |
| `topic-create` | QQ 无话题/帖子概念（超级群除外） |
| `thread-create/reply` | QQ 无 Thread 概念 |
| `broadcast` | SDK 定义有但无插件实现 |

---

## 二、事件处理

当前已处理: `message.private`, `message.group`, `message_sent`, `notice.group_decrease.kick_me`, `notice.group_ban.ban`, `notice.friend_add`, `notice.notify.poke`(日志), `notice.bot_offline`, `request.friend`, `request.group.invite`

### 群事件

| 事件 | NapCat 字段 | 说明 | 建议处理方式 | 难度 |
|------|------------|------|------------|------|
| `group_recall` | `notice_type=group_recall` | 群消息撤回。字段: `user_id`(发送者), `operator_id`(操作者), `message_id` | 立刻 `get_msg` 取原文 → 通知管理员（防撤回） | 低 |
| `friend_recall` | `notice_type=friend_recall` | 私聊消息撤回。字段: `user_id`, `message_id` | 同上，`get_msg` 取原文 | 低 |
| `group_increase` | `notice_type=group_increase` | 新成员入群。`sub_type`: `approve`(管理员同意)/`invite`(邀请) | 可选: 通知管理员 / 发欢迎语 | 低 |
| `group_decrease.leave` | `notice_type=group_decrease`, `sub_type=leave` | 成员主动退群 | 可选: 通知管理员 | 低 |
| `group_decrease.kick` | `notice_type=group_decrease`, `sub_type=kick` | 成员被踢（非机器人自己） | 可选: 通知管理员 | 低 |
| `group_decrease.disband` | `sub_type=disband` | 群解散 | 清理 groupAllowFrom + 通知管理员 | 低 |
| `group_admin.set` | `notice_type=group_admin`, `sub_type=set` | 新增管理员 | 日志/通知 | 低 |
| `group_admin.unset` | `notice_type=group_admin`, `sub_type=unset` | 取消管理员 | 日志/通知 | 低 |
| `group_card` | `notice_type=group_card` | 群名片变更。字段: `card_new`, `card_old` | 日志 | 低 |
| `group_upload` | `notice_type=group_upload` | 群文件上传。字段: `file`(含 name/size/url) | 可选: 通知/下载 | 低 |
| `group_ban.lift_ban` | `sub_type=lift_ban` | 机器人被解禁 | 通知管理员 | 低 |
| `essence` | `notice_type=essence` | 精华消息变更。`sub_type`: `add`/`delete` | 日志 | 低 |

### 其他事件

| 事件 | 说明 | 难度 |
|------|------|------|
| `notify.honor` | 群荣誉变更（龙王、群聊之火等） | 低 |
| `notify.title` | 群成员专属头衔变更 | 低 |
| `notify.lucky_king` | 运气王（红包） | 低 |
| `friend_decrease` | NapCat 扩展 — 好友减少（被删除） | 低 |

---

## 三、出站增强

当前已支持: 文本、图片、语音(`record`)、视频(`video`)、文件(`uploadFile`)、回复引用、多图

### 未实现

| 功能 | 消息段类型 | 说明 | 难度 |
|------|----------|------|------|
| 发送音乐卡片 | `music` | 支持 qq/163/kugou/kuwo/migu/custom。需要 `type`, `id` 或自定义 `url`, `audio`, `title` | 低 |
| @指定人 | `at` | SendOptions 加 `atUserIds: string[]`，构建 `at` 段。`reply` 段已有 @效果 | 低 |
| 发商城表情 | `mface` | 需要 `emoji_package_id`, `emoji_id`, `key`, `summary`。获取参数是难点 | 中 |
| 发送戳一戳 | `poke` | `type` + `id` 参数。实用性低 | 低 |
| 发送 JSON 卡片 | `json` | 自定义 JSON 卡片。需构建复杂 JSON 结构 | 中 |
| 发送位置 | `location` | 参数: `lat`, `lon`, `title`, `content` | 低 |
| 发送联系人 | `contact` | 分享 QQ 好友/群名片 | 低 |

---

## 四、ctxPayload 补全

当前入站 ctxPayload 已有: Body, From, To, SessionKey, ChatType, SenderName, SenderId, GroupSubject, MessageSid, ReplyToId/Body/Sender, MediaPaths/Types, WasMentioned, InboundHistory, CommandAuthorized 等

### 可补充字段（参考 Telegram/Discord 插件）

| 字段 | 说明 | 来源 | 难度 |
|------|------|------|------|
| `SenderUsername` | 发送者用户名/备注名 | `sender.card` 或 `sender.nickname` — 目前用 `SenderName` 已包含 | 已有(等效) |
| `SenderRole` | 群内角色（owner/admin/member） | `event.sender.role` | 低 |
| `ForwardedFrom` | 转发来源 | forward 消息段的 sender 信息 — inbound 已解析但未传到 ctxPayload | 低 |
| `ForwardedDate` | 转发原始时间 | forward 消息段的 time 字段 | 低 |
| `MediaUrl` (单数) | 第一个媒体 URL | 图片/视频/语音 URL — 目前只传 `MediaPaths`(本地文件) | 低 |
| `Sticker` | 表情包信息 | mface 的 summary — 目前作为文本传递 | 低 |
| `GroupSystemPrompt` | 群级别自定义 system prompt | 需要配置结构支持 | 中 |
| `LocationData` | 结构化位置数据 | location 消息段的 lat/lon/title | 低 |

---

## 五、NapCat 扩展 API（非标准 OneBot）

NapCat 在 OneBot v11 基础上扩展了大量 API，部分可能有用：

### 可能有用

| API | 说明 | 用途 |
|-----|------|------|
| `nc_get_rkey` | 刷新图片/文件 rkey（下载密钥） | 解决图片 URL 过期问题（约2小时） |
| `get_group_member_list` | 获取完整群成员列表 | directory 适配器增强 |
| `get_stranger_info` | 获取陌生人信息 | 丰富入站 sender 信息 |
| `get_group_honor_info` | 群荣誉信息 | 群管理 |
| `set_group_special_title` | 设置群成员专属头衔 | 群管理 action |
| `send_group_sign` | 群签到 | 趣味功能 |
| `get_essence_msg_list` | 获取精华消息列表 | list-pins action |
| `_send_group_notice` | 发群公告 | 群管理 |
| `get_group_notice` | 获取群公告 | 信息查询 |
| `get_group_file_url` | 获取群文件下载链接 | 文件下载 |
| `create_group_file_folder` | 创建群文件夹 | 文件管理 |

### 流式传输（NapCat v4.8.115+）

| API | 说明 |
|-----|------|
| `upload_file_to_shamrock` | 流式上传大文件 |
| Stream API | HTTP SSE 方式传输大文件，避免 base64 内存暴涨 |

### 实用性低 / 已明确跳过

| API | 原因 |
|-----|------|
| `get_stranger_info` | 场景有限 |
| AI 语音 | NapCat 不稳定 |
| `set_online_status` | 机器人在线状态意义不大 |
| `send_like` | 点赞（非标准功能） |
| OCR/翻译 | 有更好的外部服务 |
| 获取头像 | 可直接拼 URL: `https://q1.qlogo.cn/g?b=qq&nk={qq}&s=640` |
| 小程序发送 | 结构复杂，场景少 |

---

## 六、配置增强

| 功能 | 说明 | 难度 |
|------|------|------|
| `onboarding.configure` 合并 | 当前覆盖写入，应 `{ ...existing, ...new }` 合并 | 低 |
| 群级别 system prompt | `groupSystemPrompts: { "g群号": "..." }` | 中 |
| 群级别 agent 路由 | 不同群用不同 agent | 中（需 SDK 支持） |
| 消息防撤回开关 | `antiRecall: true` — 撤回时自动保存原文并通知管理员 | 低 |
| 群欢迎语 | `welcomeMessage: "..."` — 新成员入群自动发送 | 低 |
| 定时消息 | 定时向指定群/用户发送消息 | 中 |

---

## 七、已知限制 & 注意事项

1. **QQ 图片 URL 约2小时过期** — 需要 `nc_get_rkey` 刷新，或在入站时立即下载
2. **NapCat LRU 缓存约5000条** — `get_msg` 超出范围后无法取回
3. **QQ 语音格式为 silk** — NapCat v4.4.11+ 内置 ffmpeg 转码
4. **QQ 不支持消息编辑** — 已发送消息无法修改
5. **QQ 不支持 Markdown 富文本渲染** — 只能纯文本
6. **群管理操作需要机器人是管理员** — kick/ban/essence 等
7. **合并转发消息有频率限制** — 短时间大量发送可能被风控
8. **base64 文件上传有大小限制** — 大文件建议用 Stream API (NapCat v4.8.115+)

---

## 八、版本路线建议

### v0.7 — 群管理基础
- [ ] `kick` action
- [ ] `ban` / `ban-all` action
- [ ] `leaveGroup` action
- [ ] `renameGroup` action
- [ ] `SenderRole` 加入 ctxPayload

### v0.8 — 消息增强
- [ ] 防撤回（`group_recall` + `friend_recall` + `get_msg`）
- [ ] `group_increase` 欢迎通知
- [ ] `get_essence_msg_list` → `list-pins` action
- [ ] `nc_get_rkey` 图片链接刷新

### v0.9 — 完善
- [ ] `at` 出站支持
- [ ] `music` 音乐卡片发送
- [ ] `sticker` 商城表情发送
- [ ] 群文件管理 action
- [ ] Stream API 大文件支持

### v1.0 — 稳定版
- [ ] 全面测试
- [ ] README 文档完善
- [ ] npm 发布
