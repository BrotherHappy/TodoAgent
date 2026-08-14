# Todo Pet AI 实现交接说明

Todo Pet 是 Todo Agent 的宠物化桌面交互模式。后续交给 AI 或工程师实现时，请按以下顺序阅读：

1. [TODO_PET_PRODUCT_DESIGN.md](./TODO_PET_PRODUCT_DESIGN.md)：产品定位、用户体验、视觉、交互和完整功能范围。
2. [TODO_PET_IMPLEMENTATION_SPEC.md](./TODO_PET_IMPLEMENTATION_SPEC.md)：状态机、数据模型、IPC、Agent 权限、测试和验收标准。

## 推荐的首次实现指令

```text
请先完整阅读 docs/TODO_PET_PRODUCT_DESIGN.md 和
docs/TODO_PET_IMPLEMENTATION_SPEC.md，不要立即修改代码。

第一步只做代码审计：
1. 找到现有悬浮窗口、任务控制器、番茄钟、Agent 对话、飞书同步、设置和持久化实现；
2. 对照两份文档列出已有能力、缺失能力、可复用模块、数据迁移风险和测试缺口；
3. 给出按 TODO_PET_IMPLEMENTATION_SPEC.md 第 30 节拆分的实施计划；
4. 标明任何与规范冲突或无法确认的地方；
5. 在我确认审计结果前不要开始大规模修改。

确认后一次只实现一个阶段。每个阶段都必须运行相关单元、组件、端到端测试，
并在 Windows/macOS 真实打包应用中验证适用的桌面能力。
```

## 实现纪律

- 不要一次性实现全部 Todo Pet。
- 不要复制任务过滤、飞书同步或 Agent 权限逻辑。
- 不要用模拟数据假装飞书、天气、模型或任务操作成功。
- 不要让大模型决定基础动画、计时或权威业务状态。
- 不要破坏现有悬浮球和胶囊模式。
- 每完成一个阶段，先测试、总结差异并更新文档，再进入下一阶段。
