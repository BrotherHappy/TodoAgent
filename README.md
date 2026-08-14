# Todo Agent

> 住在桌面上的本地优先任务伙伴，适用于 macOS 和 Windows。

Todo Agent 用一只原创的 Todo Pet 替代传统悬浮球和胶囊：它常驻桌面、轮播今天的任务，也能展开为任务面板、番茄钟、流式 Agent 对话和小窝。没有账号、网络或模型时，本地任务、专注、提醒、成长与日记依然可用。

![Todo Pet 成长小窝](./docs/screenshots/todo-pet-home.png)

## 为什么是 Todo Pet

- **随时看见下一步**：宠物与任务气泡始终置顶，今日任务自动上下轮播，鼠标停留时暂停。
- **不离开当前工作**：单击或悬停展开“全部、今天、专注、聊聊、小窝”，离开自动收起；最后入口会被记住。
- **温和推动执行**：支持 25/5、50/10、90/20、正计时、暂停恢复、休息与重启恢复；完成任务和专注会形成正向成长，不因逾期或中断惩罚。
- **一处管理任务**：本地任务与可选飞书任务统一展示，保留清晰来源；飞书写入本地落盘后立即启动同步。
- **可选任务 Agent**：支持 OpenAI-compatible 模型、流式 Markdown、自然语言单条或批量增删改查，以及经确认的网页、文件和本机工具能力。
- **用户保持控制**：天气只需手工城市；长期记忆只保存用户明确批准的内容；敏感操作经过权限预览、确认与审计。

## 功能一览

| 模块 | 已包含能力 |
| --- | --- |
| Todo Pet | 唯一桌面悬浮形态、始终置顶、自由拖动、多显示器位置记忆、缩放、悬停展开、离开收起、双击主应用、右键快捷菜单、隐私与临时安静 |
| 任务 | 暂存、Today、即将到来、全部、已完成、回收站、项目、标签、优先级、子任务、循环、开始/截止时间、提醒与快速录入 |
| 专注 | 番茄钟预设、自定义节奏、正计时、任务绑定、暂停/恢复、休息轮次、重启恢复、系统通知和幂等奖励 |
| 陪伴 | 等级、亲密度、正向属性、成长记录、本地事实日记、可控记忆、城市天气、低频提醒与统一宠物/Agent 身份 |
| 飞书 | 可选零服务器连接、已有应用接入、自动/手动/交互后立即同步、离线队列、冲突入口和私人计划层 |
| Agent | 小窗与主应用流式对话、Markdown、任务 CRUD、网页研究/本机工具、权限确认、审计、停止与临时全权限模式 |
| 数据与安全 | 本地原子持久化、系统安全存储保存凭据、可恢复删除、模型数据范围、安静时段与减少动态效果 |

## 界面预览

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/todo-pet-focus.png" alt="Todo Pet 专注面板" /></td>
    <td width="50%"><img src="./docs/screenshots/todo-pet-companion.png" alt="Todo Pet 随身小窝" /></td>
  </tr>
  <tr>
    <td align="center">专注：番茄钟、正计时与任务绑定</td>
    <td align="center">小窝：成长、天气、同步和最近活动</td>
  </tr>
  <tr>
    <td width="50%"><img src="./agent-page.png" alt="任务助理与权限范围" /></td>
    <td width="50%"><img src="./docs/screenshots/floating-context-menu.png" alt="Todo Pet 右键快捷菜单" /></td>
  </tr>
  <tr>
    <td align="center">Agent：流式任务对话和权限确认</td>
    <td align="center">右键：快速新增、聊天、隐私、锁定与安静</td>
  </tr>
</table>

## 下载与安装

当前预览版本：[v0.0.1](https://github.com/BrotherHappy/TodoAgent/releases/tag/v0.0.1)。

- **macOS（Apple Silicon）**：[DMG](https://github.com/BrotherHappy/TodoAgent/releases/download/v0.0.1/Todo.Agent-0.0.1-arm64.dmg) · [ZIP](https://github.com/BrotherHappy/TodoAgent/releases/download/v0.0.1/Todo.Agent-0.0.1-arm64-mac.zip)
- **Windows x64**：[ZIP](https://github.com/BrotherHappy/TodoAgent/releases/download/v0.0.1/Todo.Agent-0.0.1-win.zip)

这是 Early Preview。macOS 产物尚未进行 Developer ID 签名和公证；Windows 包仍建议在目标设备完成安装、系统通知和多显示器实机验收。

## 从源码启动

前置条件：Node.js 20+，npm。

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run verify
npm run test:e2e
npm run capture:screenshots
npm run package:mac:current
npm run package:win:zip
```

## 隐私与安全

- 默认没有云端账号或模型依赖；本地任务不会自动上传。
- 飞书与模型均为可选项。Token、App Secret 和模型密钥由系统安全存储保护，普通设置只保存凭据引用。
- 天气只使用用户填写的城市并在本机缓存，不申请精确定位。
- 任务、天气、专注和同步是确定性事实；模型不能伪造这些状态。
- 长期记忆必须由用户明确保存或批准，并支持查看、暂停、编辑和删除。
- Agent 只能通过类型化工具提出操作；批量、外部和高风险操作在标准模式下请求确认。

详细设计与边界：

- [统一 PRD](./docs/PRD.md)
- [Todo Pet 产品设计](./docs/TODO_PET_PRODUCT_DESIGN.md)
- [Todo Pet 实现规范](./docs/TODO_PET_IMPLEMENTATION_SPEC.md)
- [页面信息架构与交互](./docs/UX_INFORMATION_ARCHITECTURE.md)
- [飞书连接说明](./docs/FEISHU_CONNECTION.md)
- [技术架构与测试门禁](./docs/TECHNICAL_ARCHITECTURE.md)

## 当前边界

- 飞书 Task V2 的列表接口当前以“我负责”的任务范围为主；可访问但不在该范围内的任务不会被误删。
- 天气使用结构化公共服务，供应商不可用时保留并标明最后缓存结果。
- 真实飞书租户、Windows 设备、全屏应用和多显示器组合仍需要持续实机验收。
- 当前仓库尚未声明开源许可证；除非另有明确书面许可，保留全部权利。
