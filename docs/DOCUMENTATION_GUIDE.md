# Todo Agent 文档维护与代码映射指南

> 文档状态：项目协作约定<br>
> 更新日期：2026-08-30<br>
> 适用版本：`0.0.1` 及后续版本

这份指南把 Todo Agent 的产品定义、设计决策和工程实现连接起来。它是给产品、设计、工程师和后续 AI 使用的“导航页”，不取代具体文档中的详细规则。

## 1. 文档如何成为产品的一部分

`docs/` 是项目的产品知识库，应用内的「文档中心」会在构建时读取这里的 Markdown，并提供目录、搜索、目录跳转和文档间链接。源文件仍然是唯一事实来源：修改文档后重新运行构建，应用内即可看到新内容。

文档中心遵循开源项目常见的 README → 指南 → 规范 → 验收顺序：先理解目标，再查看体验与工程约束，最后用状态和测试证据确认完成度。

## 2. 文档分层

| 分层 | 主要文件 | 回答的问题 |
| --- | --- | --- |
| 开始与约定 | `README.md`、本文 | 我应该从哪里开始？怎样维护和交接？ |
| 产品与研究 | `PRD.md`、`COMPETITIVE_PRODUCT_RESEARCH.md` | 做什么、为谁做、为什么做？ |
| 体验与视觉 | `UX_INFORMATION_ARCHITECTURE.md`、`UI_VISUAL_DIRECTION.md` | 页面怎么组织、怎么操作、长什么样？ |
| Todo Pet | `TODO_PET_PRODUCT_DESIGN.md`、`TODO_PET_ACTION_INTERACTION_SPEC.md`、`TODO_PET_ATLAS_DESIGN.md` | 宠物如何陪伴、动作如何表达状态？ |
| 工程与集成 | `TECHNICAL_ARCHITECTURE.md`、`FEISHU_CONNECTION.md`、`CLAWD_INTEGRATION.md` | 如何实现、怎样接入、边界在哪里？ |
| 验收与发布 | `TODO_PET_IMPLEMENTATION_SPEC.md`、`IMPLEMENTATION_STATUS.md`、`QA_REAL_USER_AUDIT.md`、`GOAL_ACCEPTANCE_MATRIX.md` | 怎样验证，当前完成到什么程度？ |

## 3. 文档与代码映射

| 文档关注点 | 主要代码入口 | 验证方式 |
| --- | --- | --- |
| 产品路由、任务列表、主导航 | `src/renderer/App.tsx`、`src/renderer/styles.css` | 页面测试、E2E 主流程 |
| 任务模型与本地优先事实 | `src/shared/models.ts`、`electron/task-service.ts` | 任务服务与同步测试 |
| 飞书 OAuth、拉取、写回、冲突 | `electron/feishu-*`、`src/shared/desktop-api.ts` | `feishu-sync-service`、真实账号验收 |
| Agent 对话、工具、审批和模型 | `electron/agent-*`、`src/renderer/AgentMarkdown.tsx` | Agent 流式、权限和工具测试 |
| Todo Pet 状态、动作、图集 | `src/renderer/PetCharacter.tsx`、`src/renderer/pet-*`、`src/renderer/pet-atlas.ts` | Pet 组件、动作状态和桌面窗口测试 |
| 桌面窗口、快捷键、自动启动 | `electron/window-manager.ts`、`electron/main.ts` | 窗口管理与安装包验收 |
| 测试和质量门禁 | `tests/`、`playwright.config.ts` | `npm run verify`、E2E 和人工走查 |

如果某个功能发生变化，请同时检查它对应的产品文档、实现状态和验收记录。文档之间有冲突时，按以下优先级处理：用户最新确认 > `PRD.md` > 专项设计规范 > 技术实现说明 > 历史记录。

## 4. 推荐修改流程

1. 先在 `PRD.md` 写清楚目标、用户价值、优先级和验收标准。
2. 页面或宠物体验变化，补充 `UX_INFORMATION_ARCHITECTURE.md`、`UI_VISUAL_DIRECTION.md` 或 Todo Pet 专项规范。
3. 涉及 IPC、数据、权限或同步时，更新技术与集成文档，并写明失败和回滚路径。
4. 实现后更新 `IMPLEMENTATION_STATUS.md`、`QA_REAL_USER_AUDIT.md` 或 `GOAL_ACCEPTANCE_MATRIX.md`，只记录可复现证据，不写入任务内容、Token、App Secret 或模型密钥。
5. 运行 `npm run typecheck`、`npm test`、`npm run build`；需要发布时再运行对应平台的打包脚本。

## 5. 给下一位 AI 的交接模板

开始工作前，先说明：

- 要解决的用户场景和不包含的范围；
- 需要阅读的文档和对应代码入口；
- 会改变的任务事实、权限或外部写入；
- 可复现的测试、人工验收和回滚方式。

结束工作时，必须说明：

- 修改了哪些文件和用户可见行为；
- 哪些测试通过，哪些仍需要真实账号、系统权限或人工确认；
- 是否重新构建、打包和安装；
- 后续文档或产品决策仍有哪些待办。

## 6. 文档中心的使用方式

在 Todo Agent 主窗口左侧打开「文档中心」即可浏览全部 Markdown。可以按关键词筛选，选择文档后使用本文目录跳转，也可以点击文档中的相对链接前往另一篇文档。文档中心会记住上次阅读的文章，重新打开应用时继续上次位置。
