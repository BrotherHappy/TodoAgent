# Todo Agent

> 住在桌面上的本地优先任务伙伴，适用于 macOS 和 Windows。

Todo Agent 用一只原创的 Todo Pet 替代传统悬浮球和胶囊：它常驻桌面、轮播今天的任务，也能展开为任务面板、番茄钟、流式 Agent 对话和小窝。没有账号、网络或模型时，本地任务、专注、提醒、成长与日记依然可用。

![Todo Pet 成长小窝](./docs/screenshots/todo-pet-home.png)

## 为什么是 Todo Pet

- **随时看见下一步**：宠物与任务气泡始终置顶，今日任务自动上下轮播，鼠标停留时暂停。
- **宠物真的活着**：头、眼、耳、尾巴和四肢独立运动，持续呼吸、随机眨眼并跟随鼠标；点击不同身体部位会歪头、惊讶、击掌或笑着躲开。
- **不离开当前工作**：默认只保留宠物本体；点击宠物旁箭头可收回或恢复“全部、今天、专注、聊聊、小窝”任务栏，悬停展开和离开收起仍可用，最后入口与仅宠物模式都会被记住。
- **温和推动执行**：支持 25/5、50/10、90/20、正计时、暂停恢复、休息与重启恢复；完成任务和专注会形成正向成长，不因逾期或中断惩罚。
- **一处管理任务**：本地任务与可选飞书任务统一展示，保留清晰来源；飞书写入本地落盘后立即启动同步。
- **可选任务 Agent**：支持 OpenAI-compatible 模型、流式 Markdown、自然语言单条或批量增删改查，以及经确认的网页、文件和本机工具能力。
- **用户保持控制**：天气只需手工城市；长期记忆只保存用户明确批准的内容；敏感操作经过权限预览、确认与审计。

## 功能一览

| 模块 | 已包含能力 |
| --- | --- |
| Todo Pet | 20 种待机动作、8 种情绪、身体分区点击、任务卡拖放、始终置顶、自由拖动、多显示器位置记忆、缩放、仅宠物模式、任务栏收回/恢复、悬停展开、双击主应用、右键快捷菜单、隐私与免打扰 |
| 任务 | 暂存、Today、即将到来、全部、已完成、回收站、项目、标签、优先级、子任务、循环、开始/截止时间、提醒与快速录入 |
| 专注 | 番茄钟预设、自定义节奏、正计时、任务绑定、暂停/恢复、休息轮次、重启恢复、系统通知和幂等奖励 |
| 陪伴 | 等级、亲密度、正向属性、三种小房间、配色/服装/摆件、每日冒险、两种休息小游戏、本地事实日记、可控记忆、天气与早晚提醒 |
| 飞书 | 可选零服务器连接、已有应用接入、自动/手动/交互后立即同步、离线队列、冲突入口和私人计划层 |
| Agent | 小窗与主应用流式对话、Markdown、任务 CRUD、网页研究/本机工具、权限确认、审计、停止与临时全权限模式 |
| 数据与安全 | 本地原子持久化、系统安全存储保存凭据、可恢复删除、模型数据范围、安静时段与减少动态效果 |

## 悬浮桌面模式

Todo Pet 有三种连续的桌面形态：

1. **仅宠物**：只保留可拖动、可点击互动的宠物本体，窗口会同步缩小，不会用透明区域挡住桌面。
2. **宠物 + 任务栏**：显示当前任务、专注计时和宠物消息气泡；任务栏支持全部、今天、专注、聊聊和小窝五个入口。
3. **完整小窗口**：展开任务列表、Agent 对话、专注控制和小窝内容。

点击宠物旁的箭头可以在“仅宠物”和“宠物 + 任务栏”之间切换；互动轮盘和小游戏会临时展开所需空间，结束后自动回到原来的模式。仅宠物模式与最后选中的任务入口会在本地记忆，重启应用后继续使用。

## 界面预览

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/todo-pet-room.png" alt="Todo Pet 可布置小房间" /></td>
    <td width="50%"><img src="./docs/screenshots/todo-pet-adventure.png" alt="Todo Pet 每日冒险" /></td>
  </tr>
  <tr>
    <td align="center">小房间：配色、服装、主题与摆件</td>
    <td align="center">每日冒险：选择、故事结果与无压力成长</td>
  </tr>
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
- [竞品研究与可借鉴设计](./docs/COMPETITIVE_PRODUCT_RESEARCH.md)
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

## 设计研究

我们把 Todo Pet 放在“任务管理 × 桌面宠物 × AI Agent”的交叉点上，持续对照 Todoist、TickTick、Things、OmniFocus、Sunsama、Motion、Notion AI、Taskade、Vikunja、Super Productivity、Finch、Forest、Habitica、Weyrdlets、Shimeji 等产品的 UI、交互和功能。

详细的竞品矩阵、优势差异、可迁移模式、风险取舍和 P0/P1/P2 实现清单见：[竞品研究与可借鉴设计](./docs/COMPETITIVE_PRODUCT_RESEARCH.md)。这份研究也明确了 Todo Pet 的边界：真实任务和飞书同步是事实层，宠物是陪伴层，Agent 必须经过权限预览；不使用宠物死亡、饥饿、扣资产或强制连续签到制造压力。
