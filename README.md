# openclaw-napcatqq

OpenClaw 通道插件 —— 通过 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)（OneBot v11 WebSocket）对接 QQ。

整体设计对齐 OpenClaw ChannelPlugin SDK，当前已实现核心通道适配能力与 6 个消息 Action。

## 功能

### 消息能力

- ✅ 私聊 / 群聊收发文本消息
- ✅ 图片收发（入站：下载转 base64 → Agent ImageContent，最多 5 张；出站：URL/base64 发送）
- ✅ 多图发送（Agent 返回多张图片时自动逐张发送）
- ✅ 语音收发（入站：自动下载转写；出站：`record` 消息段独立发送）
- ✅ 视频消息解析（入站：URL 附加到文本供 Agent 参考）
- ✅ 语音转写（委托 SDK `transcribeFirstAudio`，支持 openai / deepgram / google / groq 等 provider）
- ✅ 引用回复（入站：提取被引用消息内容和发送者；出站：`[[reply_to:xxx]]` 标签）
- ✅ 文件发送（`sendAttachment` action，通过 `base64://` 前缀跨服务器传输）
- ✅ 全量消息段解析（23 种 OneBot v11 段类型：表情/视频/文件/位置/卡片/小程序/合并转发等）
- ✅ QQ 表情 → Unicode Emoji 映射（130+ 个 face ID 双向映射）
- ✅ 合并转发消息展开（解析前 5 条转发内容含发送者名称）
- ✅ Markdown 感知的长消息自动切分（4000 字符限制）
- ✅ Typing 输入状态指示（私聊显示"正在输入"，NapCat `set_input_status` API）

### 消息 Action（6 个）

| Action | 说明 |
|--------|------|
| `send` | 主动发消息（指定目标 QQ 号或 `g群号`） |
| `reply` | 引用回复指定消息 |
| `react` | 消息表情回应（`set_msg_emoji_like`，默认 👍） |
| `read` | 标记消息已读 |
| `sendAttachment` | 发送文件（私聊/群聊） |
| `member-info` | 查询群成员信息（角色/头衔/等级） |

### 访问控制

- ✅ 私聊配对认证（pairing）— 新用户需管理员审批
- ✅ 私聊 QQ 快捷审批 — 管理员直接回复 `批准用户 QQ号`
- ✅ 群聊配对审批（pairing）— 新群需管理员批准
- ✅ 群聊 QQ 快捷审批 — 管理员直接回复 `批准群 群号`
- ✅ 群聊 @机器人 过滤（可配置）
- ✅ 群聊白名单（allowlist）/ 全开放（open）/ 关闭（disabled）
- ✅ `/model` `/status` `/reset` 等斜杠命令（权限基于 allowFrom）
- ✅ 控制命令拦截（未授权用户发控制命令静默丢弃）

### 事件处理

- ✅ `notice.group_decrease.kick_me` — 机器人被踢出群自动清理 + 通知管理员
- ✅ `notice.group_ban.ban` — 机器人被禁言检测 + 通知管理员（含时长/操作者）
- ✅ `notice.friend_add` — 新好友添加通知管理员
- ✅ `request.friend` — 好友请求处理（`autoAcceptFriend` 开关，默认关闭）
- ✅ `request.group.invite` — 入群邀请处理（`autoAcceptGroupInvite` 开关，默认关闭）
- ✅ `message_sent` — 机器人自发消息记入群聊历史上下文
- ✅ `bot_offline` — 机器人离线通知管理员
- ✅ `notify.poke` — 戳一戳事件日志记录
- ✅ 收到消息自动标记已读（`mark_msg_as_read`）
- ✅ 收到消息可选表情回应（`emojiAck` 开关）

### 群聊增强

- ✅ 群聊历史上下文（被忽略的消息作为 Agent 上下文）
- ✅ 启动时预加载已批准群的历史消息（`get_group_msg_history`）
- ✅ 消息防抖合并（连续多条消息合并为一条处理）
- ✅ Agent 信封格式（`发送者@群名`，含时间戳）
- ⚠️ 群聊工具权限策略目前未做独立实现（当前 `resolveToolPolicy()` 返回 `undefined`）

### 连接与管理

- ✅ WSS 支持（宝塔 / Nginx HTTPS 反代）
- ✅ Token 通过 `Authorization: Bearer` Header 传递（不暴露在 URL）
- ✅ 自动重连 + 心跳检测（默认 60 秒超时）
- ✅ 重连时自动清理挂起的 API 调用
- ✅ 多账号
- ✅ `openclaw channels login` 向导式配置（10 步）
- ✅ 控制面板 JSON Schema 表单渲染（全中文标签）
- ✅ 热重载（修改配置后无需重启 Gateway）
- ✅ `openclaw status` 状态展示（bot 昵称、连接状态、问题诊断）
- ✅ selfId 自动回写（连接成功后自动将机器人 QQ 号写入配置）
- ✅ 联系人/群列表目录查询
- ✅ 启动时自动同步 credentials pairing store 到 `dm.allowFrom` 配置

### 能力声明

| 能力 | 状态 |
|------|------|
| 私聊 / 群聊 | ✅ |
| 引用回复 | ✅ |
| 媒体（图片/语音/视频/文件） | ✅ |
| 表情回应 | ✅ |
| 撤回消息 | ❌（当前未对外暴露 action） |
| 消息编辑 | ❌（QQ 协议不支持） |
| 投票 | ❌ |
| 消息线程 | ❌ |
| 消息特效 | ❌ |

## 前置条件

1. 一台运行 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的服务器，**正向 WebSocket** 已开启
2. NapCat 消息格式设为 **Array**（推荐；String 格式也支持，自动兼容）
3. OpenClaw Gateway 已安装并运行

## 安装

### 从 GitHub 安装

```bash
openclaw plugins install github:longlannet/openclaw-napcatqq
```

### 从本地目录安装（开发模式）

```bash
git clone https://github.com/longlannet/openclaw-napcatqq.git
openclaw plugins install ./openclaw-napcatqq --link
```

> `--link` 创建符号链接，修改源码即时生效，适合开发调试。

安装命令会自动添加 `plugins.allow` 和 `plugins.load.paths` 配置，无需手动编辑。
插件使用 `.ts` 源码直接加载，无需编译。

## 配置

### 方式一：向导式（推荐）

```bash
openclaw channels login napcatqq
```

向导会依次询问：

1. **账号 ID** — 多账号标识（默认 `default`）
2. **WebSocket URL** — `wss://你的域名`（必填）
3. **Access Token** — OneBot access_token（可留空）
4. **DM 访问策略** — pairing（需审批）/ open（全放行）/ closed（全拒绝）
5. **管理员 QQ 号** — 必填，用于审批通知
6. **群聊策略** — disabled / pairing / open / allowlist
7. **群聊 @机器人** — 是否需要 @才响应
8. **自动同意好友请求** — 是否自动接受
9. **自动同意入群邀请** — 是否自动接受
10. **消息表情回应** — 收到消息是否打 ❤️

### 方式二：手动编辑 `openclaw.json`

```jsonc
{
  "channels": {
    "napcatqq": {
      "accounts": {
        "default": {
          "enabled": true,
          "wsUrl": "wss://你的域名",
          "accessToken": "你的token",
          "requireMention": true,
          "groupPolicy": "pairing",
          "groupAllowFrom": [],
          "allowFrom": ["你的QQ号"],
          "autoAcceptFriend": false,
          "autoAcceptGroupInvite": false,
          "emojiAck": false,
          "dm": {
            "policy": "pairing",
            "allowFrom": []
          }
        }
      }
    }
  }
}
```

### 配置完成后重启 Gateway

```bash
openclaw gateway restart
```

## 配置参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `wsUrl` | string | **必填** | NapCat WebSocket 地址，如 `wss://ncqq.example.com` |
| `accessToken` | string | — | OneBot access_token，通过 Authorization Header 传递 |
| `selfId` | string | 自动获取 | 机器人 QQ 号，连接后自动提取并回写到配置 |
| `requireMention` | boolean | `true` | 群聊是否需要 @机器人 才响应 |
| `commandPrefix` | string | `"/"` | 命令前缀 |
| `defaultTo` | string | — | 默认发送目标（message 工具省略 target 时使用） |
| `groupPolicy` | string | `"disabled"` | 群聊策略：`disabled` / `open` / `allowlist` / `pairing` |
| `groupAllowFrom` | array | — | 群聊白名单（`g群号` 或纯群号） |
| `historyLimit` | number | `50` | 群聊历史消息缓存条数上限 |
| `allowFrom` | array | — | 管理员/白名单 QQ 号列表 |
| `autoAcceptFriend` | boolean | `false` | 自动同意好友请求（关闭时仅通知管理员） |
| `autoAcceptGroupInvite` | boolean | `false` | 自动同意入群邀请（关闭时仅通知管理员） |
| `emojiAck` | boolean | `false` | 收到消息时自动打 ❤️ 表情回应 |
| `dm.policy` | string | `"pairing"` | 私聊策略：`pairing` / `open` / `closed` |
| `dm.allowFrom` | array | — | 私聊白名单（与 `allowFrom` 合并使用，非互斥） |

## 访问控制

### allowFrom 合并规则

`dm.allowFrom` 和 `allowFrom` 是**合并关系**，不是覆盖关系。访问控制检查时，两个列表中的 QQ 号都被视为已授权。例如：

```jsonc
{
  "allowFrom": ["123456"],       // 管理员
  "dm": {
    "allowFrom": ["789012"]      // 已批准的用户
  }
}
// 实际生效的白名单 = ["123456", "789012"]
```

### 私聊配对

插件默认使用 `pairing` 策略（和 Telegram 一致）：

1. 陌生用户私聊机器人 → 用户收到「⏳ 需要管理员批准」
2. 管理员（`allowFrom` 中的 QQ 号）同时收到通知，包含昵称/QQ号/消息预览
3. 两种审批方式（任选其一）：
   - **QQ 快捷审批**：管理员直接回复 `批准用户 QQ号`
   - **CLI 审批**：`openclaw pairing approve napcatqq <Code>`
4. 用户收到配对成功通知，后续消息正常路由到 Agent

> **双存储机制**：QQ `批准用户` 命令写入配置文件的 `dm.allowFrom`；CLI `openclaw pairing approve` 写入 `~/.openclaw/credentials/napcatqq-default-allowFrom.json`。插件启动时自动同步 credentials store 到 `dm.allowFrom`，两种方式都有效。

### 群聊审批

当 `groupPolicy` 设为 `pairing` 时：

1. 有人在新群 @机器人 → 管理员私聊收到通知（群名/群号/发送者）
2. 两种审批方式（任选其一）：
   - **QQ 快捷审批**：管理员回复 `批准群 群号`
   - **CLI 配置**：`openclaw config set channels.napcatqq.accounts.default.groupAllowFrom --append g群号`
3. 审批后该群永久生效（写入 `groupAllowFrom` 配置）

### 群聊策略对比

| 策略 | 行为 |
|------|------|
| `disabled`（默认） | 完全忽略群聊消息（静默记录历史） |
| `pairing` | 新群需管理员审批，已批准群正常响应 |
| `allowlist` | 仅 `groupAllowFrom` 中的群号可触发 |
| `open` | 所有群都可触发（需 @机器人，除非 `requireMention: false`） |

### 管理已批准用户

```bash
# 查看待审批列表
openclaw pairing list napcatqq

# CLI 批准
openclaw pairing approve napcatqq <Code>
```

## 消息支持

### 入站（QQ → Agent）

| 类型 | 处理方式 |
|------|---------|
| 文本 | 直接传递 |
| 图片 | 下载转 base64 ImageContent（最多 5 张），文本标记 `[图片]` 或 `[图片: 描述]` |
| 语音 | 下载到本地临时文件 → SDK 自动转写 → 清理临时文件 |
| 视频 | 提取视频 URL 附加到文本 `[视频: URL]`，供 Agent 参考 |
| 文件 | `[文件: 文件名]` 或 `[文件: 文件名 (大小)]` |
| QQ 表情 | 自动映射为 Unicode Emoji（130+ 表情，未映射的显示 `[表情:ID]`） |
| 商城表情 | 表情摘要如 `[开心]` |
| 位置 | `[位置: 标题 内容 (经纬度)]` |
| JSON 卡片 | 提取摘要 `[卡片: 描述]` |
| 小程序 | `[小程序消息]` |
| 合并转发 | 展开前 5 条转发内容（含发送者名称） |
| 引用回复 | 通过 `get_msg` API 获取被引用消息的内容和发送者 |
| @提及 | 提取被 @ 的 QQ 号列表，用于 mention 检测 |

### 出站（Agent → QQ）

| 类型 | 支持 |
|------|------|
| 纯文本 | ✅ |
| 图片（URL / base64） | ✅ |
| 多图发送 | ✅（逐张发送） |
| 语音 | ✅（独立发送，不与文本混合） |
| 视频 | ✅（独立发送，不与文本混合） |
| 文件 | ✅（`sendAttachment` action，base64 跨服务器传输） |
| 引用回复 | ✅（`[[reply_to:xxx]]` 标签 或 `reply` action） |
| 表情回应 | ✅（`react` action） |
| 撤回消息 | ❌（已降级为群管指令预留，大模型日常对话不建议使用） |

> **QQ 协议限制**：语音和视频消息段必须独立发送，不能和文本混在同一条消息中。插件自动处理：有文本+语音时，先发文本再发语音。

### 语音转写配置

语音转写由 OpenClaw SDK 内置的 `transcribeFirstAudio` 处理，需要在 `openclaw.json` 中配置音频转写 provider：

```jsonc
{
  "tools": {
    "media": {
      "audio": {
        "provider": "openai"  // 支持: openai / deepgram / google / groq / minimax 等
      }
    }
  }
}
```

转写流程：QQ 语音 → 下载到本地临时文件（自动检测 `.silk` / `.amr` 格式）→ SDK 转写 → 文字 → 自动清理临时文件

如果未配置 `tools.media.audio` 或转写失败，语音消息保留为 `[语音消息]`，不影响其他功能。

## 斜杠命令

在 QQ 对话中直接输入：

| 命令 | 说明 |
|------|------|
| `/model <模型名>` | 切换当前会话模型 |
| `/status` | 查看会话状态 |
| `/reset` | 重置会话上下文 |

命令权限基于 `allowFrom` 白名单，未授权用户的命令会被静默丢弃。

## 消息目标格式

通过 `message` 工具向 QQ 发消息时：

- **私聊**：直接填 QQ 号，如 `12345678`
- **群聊**：加 `g` 前缀，如 `g87654321`
- **默认目标**：配置 `defaultTo` 后可省略 `target` 参数

## 网络架构

```
QQ 用户
  ↕ QQ 协议
NapCatQQ (服务器 A, 端口 3001)
  ↕ ws://127.0.0.1:3001
Nginx / 宝塔反代 (服务器 A)
  ↕ wss://你的域名
OpenClaw Gateway (服务器 B, 主动连接 →)
  ↕ Agent 处理
QQ 用户收到回复
```

### 反代配置

NapCat WebSocket 是**长连接**，Nginx 默认 60 秒超时会断开，必须调大：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;   # 24 小时
    proxy_send_timeout 86400s;
}
```

> 插件内置心跳检测（默认 60 秒超时），即使网络中断也会自动重连。

## 多账号

支持同时连接多个 QQ 号：

```jsonc
{
  "channels": {
    "napcatqq": {
      "accounts": {
        "bot1": {
          "enabled": true,
          "wsUrl": "wss://bot1.example.com",
          "accessToken": "token1",
          "allowFrom": ["管理员QQ号"]
        },
        "bot2": {
          "enabled": true,
          "wsUrl": "wss://bot2.example.com",
          "accessToken": "token2",
          "allowFrom": ["管理员QQ号"]
        }
      }
    }
  }
}
```

## SDK 适配器清单

插件当前实现了 OpenClaw ChannelPlugin 的核心适配器集合：

| 适配器 | 功能 |
|--------|------|
| `meta` | 通道标识、标签、别名 |
| `capabilities` | 能力声明（支持/不支持的特性） |
| `configSchema` | JSON Schema + UI Hints（控制面板中文表单） |
| `config` | 账号配置读写、allowFrom 解析、defaultTo |
| `onboarding` | 向导式配置（`openclaw channels login`，10 步） |
| `setup` | 快捷配置（`openclaw channels add`） |
| `security` | DM 策略、安全警告检测 |
| `pairing` | 配对认证（idLabel、审批通知） |
| `groups` | 群聊 mention 策略（工具权限当前未单独实现） |
| `directory` | 联系人/群列表（`get_friend_list` / `get_group_list`） |
| `messaging` | 目标解析、格式化显示 |
| `threading` | 无线程；但支持显式引用回复标签 |
| `outbound` | 出站消息发送（文本/图片/语音/视频/文件/chunker） |
| `status` | 连接状态、bot 信息、问题诊断 |
| `gateway` | WS 长连接管理（start/stop/probe；logout 仅清连接凭据） |

## 文件结构

```
openclaw-napcatqq/
├── README.md
├── ROADMAP.md                  # 未实现功能路线图
├── package.json                # npm 包定义
├── tsconfig.json               # TypeScript 配置（仅类型检查）
├── index.ts                    # 入口 + PluginRuntime 初始化
└── src/
    ├── types.ts                # OneBot v11 全量类型（23 种消息段 + 事件 + API）
    ├── runtime.ts              # PluginRuntime 全局引用
    ├── client-store.ts         # WebSocket 客户端连接池
    ├── ws-client.ts            # WebSocket 客户端（自动重连 + 心跳 + echo 匹配 + 重连清理）
    ├── inbound.ts              # 入站消息解析（Array + CQ码双模式 + QQ表情映射 + 转发展开）
    ├── outbound.ts             # 出站消息发送 + 语音/视频独立发送 + 文件上传 + API 调用
    ├── config.ts               # 配置读取辅助 + ChannelConfigAdapter
    ├── config-schema.ts        # JSON Schema + UI Hints（控制面板中文表单）
    ├── onboarding.ts           # 向导式配置 + Setup 适配器（10 步）
    ├── gateway.ts              # WS 长连接管理（事件路由 / 通知处理 / 请求处理 / 历史预加载）
    ├── handler.ts              # 入站消息处理（访问控制 / 音频下载 / 上下文构建 / 回复分发）
    └── channel.ts              # 通道胶水层（meta / capabilities / 6 actions / outbound / status + 导出）
```

## 协议

OneBot v11（NapCatQQ 实现）

## License

MIT
