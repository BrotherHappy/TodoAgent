# Todo Pet × clawd-on-desk 能力融合说明

本文记录 Todo Agent 对 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的能力借鉴、实现边界和接入方式。目标是把“桌面宠物是 Agent 的可见身体”融入 Todo Pet，同时保留 Todo Agent 的本地优先任务、飞书同步、权限确认和数据隔离。

## 已融合的体验能力

| clawd-on-desk 的能力 | Todo Agent 当前实现 |
| --- | --- |
| 多 Agent 状态 | 外部 Agent 活动桥接；支持 Claude Code、Codex CLI、Copilot CLI、Gemini CLI、Antigravity、Cursor、CodeBuddy、WorkBuddy、Kiro、Kimi、Qwen Code、ZCode、CodeWhale、OpenClaw、Hermes、opencode、MiMo Code、Pi、Qoder、QoderWork、QwenWork、Reasonix、TraeCode、DeepSeek Harness 和自定义 Agent |
| 思考 / 工作 / 并行子任务动作 | 宠物状态机映射到思考、执行、并行抛球、等待确认、错误、整理上下文、搬运工作区等动作 |
| Permission 气泡 | Todo Agent 原有的 Agent 风险确认气泡；外部活动仅显示“等待确认”，不会替外部 Agent 自动批准 |
| 轻量桌面宠物 | 原创 SVG 宠物、默认像素化视觉皮肤、呼吸、眨眼、眼神跟随、互动动作、任务/专注/同步气泡、折叠和拖动 |
| 位置记忆、置顶、点击穿透、自动启动 | Todo Agent 的桌面窗口层已支持；位置按显示器记忆并在窗口移动后保存；右键可开启边缘收纳，移入探头、移出收回；错误或等待确认等高优先级外部状态会短暂自动探头 |
| DND / Boss / 专注陪伴 | Todo Agent 的休假、Boss、会议、安静时段和专注守护策略 |
| 多会话 HUD | 活动气泡显示当前 Agent、状态、工具、模型、工作区尾部和会话数量；最多展示 4 个会话摘要；主应用“动态”页提供实时会话卡、状态点、最近事件和刷新入口 |
| 单实例和启动恢复 | Todo Agent Electron 主进程已处理单实例、启动恢复和显示器变更 |

目标仓库还包含像素主题、自动更新、PWA 移动伴侣等独立产品能力。Todo Agent 暂不复制其代码或素材，而是保持自己的宠物形象和任务交互，以避免把 AGPL 代码混入当前未授权发行包。后续如果要直接分发目标仓库的代码/素材，必须先做许可证合规评估并随发行物提供对应源代码与声明。

## 外部 Agent 活动协议

打开 Todo Agent → 设置 → 模型与 Agent → 外部 Agent 活动桥接，开启后点击“显示接入信息”。桥接会监听 `127.0.0.1` 的动态端口，优先使用 `23333`–`23337`；端口被占用会自动尝试下一个。Token 保存在当前用户数据目录的 `agent-activity/token`，文件权限为 `0600`；运行时描述文件为 `agent-activity/runtime.json`，不包含 Token。

请求：

```http
POST http://127.0.0.1:<port>/state
Authorization: Bearer <token>
Content-Type: application/json
```

最小 payload：

```json
{
  "agent_id": "codex",
  "session_id": "session-123",
  "event": "PreToolUse"
}
```

也可以直接发送状态：

```json
{
  "agent_id": "openclaw",
  "session_id": "session-123",
  "state": "juggling",
  "subagent_count": 3,
  "tool_name": "terminal.exec",
  "model": "gpt-5.6-sol",
  "cwd": "/workspaces/TodoAgent"
}
```

如果外部 Agent 的 hook 能运行 Node.js，可以使用仓库自带的无依赖发送器，避免在每个 hook 中重复处理 Token 和 JSON：

```bash
export TODO_AGENT_ACTIVITY_RUNTIME="/path/to/agent-activity/runtime.json"
node scripts/todo-agent-activity.mjs \
  --agent codex \
  --session "$SESSION_ID" \
  --event PreToolUse \
  --tool terminal.exec \
  --quiet
```

发送器会从 `runtime.json` 读取回环端点，从旁边的 `token` 文件读取凭据，并在发送前限制字段长度；它不会接受或转发提示词、工具参数和文件内容。`--runtime` 也可以替代环境变量，便于在不同 Agent 的 hook 配置中复用。

支持的状态：`idle`、`thinking`、`working`、`juggling`、`error`、`attention`、`notification`、`sweeping`、`carrying`、`sleeping`。

支持的事件映射：

| 事件 | 宠物状态 |
| --- | --- |
| `SessionStart` | `idle` |
| `UserPromptSubmit` | `thinking` |
| `PreToolUse` / `PostToolUse` | `working` |
| `SubagentStart` | `juggling` |
| `PostToolUseFailure` | `error` |
| `Stop` / `PostCompact` | `attention` |
| `PermissionRequest` | `notification` |
| `PreCompact` | `sweeping` |
| `WorktreeCreate` | `carrying` |
| `SessionEnd` | 删除该会话 |

`sleeping` 是可持续展示的睡眠姿态，不会立即删除会话；只有 `SessionEnd` 或明确的 `terminal: true` 才会结束该会话，之后仍按状态保留时间自动清理。

桥接会拒绝无效 JSON、缺少 Token、未允许的 Agent、过大 payload 和超长字段。它不会读取或接受提示词、工具参数、文件内容、凭据、完整路径或网络请求；工作区只显示最后两级目录名称。默认 120 秒没有新状态的会话会自动移除，可在设置中调整为 30 秒至 15 分钟。

健康检查：

```http
GET http://127.0.0.1:<port>/health
```

健康检查不返回 Token；`/state` 不开放跨域，也不绑定局域网地址。

## Agent 模型与订阅的边界

clawd-on-desk 的“模型接入”本质上是监听外部 CLI/Agent 的状态，不是一个独立的模型网关。Todo Agent 的对话模型仍使用现有 OpenAI-compatible 主模型 + 本地备用模型路由：

- 主模型：可填写任意兼容 Chat Completions 的 URL、模型名和 API Key；
- 备用模型：可配置第二个 URL/模型，在主模型遇到可重试错误时接管；
- 本地模型：可设置为无 API Key 的可信回环服务；
- Codex 订阅：由 Codex CLI 自己负责登录和计费，Todo Pet 通过活动桥接观察其状态，不会读取订阅凭据，也不会假装把订阅转换成通用 API Key。

因此，想让 Codex/OpenClaw/Hermes/opencode 的工作出现在宠物上，只需要让对应 hook/插件向 `/state` POST；想让 Todo Agent 自己聊天和管理任务，则在“模型连接”中配置主/备用模型。

## 安全与隐私设计

1. 仅监听本机回环地址，默认关闭；
2. 每次状态请求都需要恒定时间比较的 Bearer Token；
3. Token 文件和运行时文件使用用户私有权限；
4. 活动状态只在内存中保存，不进入任务、Agent 对话、审计导出或飞书同步；
5. 允许 Agent 列表由用户控制，未知 Agent 只能在显式开启“自定义 Agent”后接入；
6. 外部 `notification` 只表现为“等待确认”状态，不会由 Todo Agent 自动点击外部权限；
7. 关闭桥接会立即停止端口、清空内存会话并删除运行时描述文件，Token 保留以便下次启用。

## 后续迭代

- 为 Claude Code、Codex CLI、OpenClaw、Hermes 和 opencode 生成可复制的 hook 配置片段；
- 已增加边缘探头/收纳动画（使用 Todo Agent 自有素材）；像素风主题仍保持为可选视觉方向，不直接导入目标项目素材；
- 增加 Agent 活动时间线与“打开对应终端”快捷入口；
- 评估自动更新和移动伴侣，但必须先确定签名、发布渠道和隐私策略；
- 如果未来直接复用 AGPL 代码或素材，单独建立许可合规包和 NOTICE 文件，不与本桥接协议混为一谈。
