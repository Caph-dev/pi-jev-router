# 后续 issue 候选

按槽位记录待办，供之后开 issue 使用；不是已实现行为，也不是验收证据。

## 按槽位配置思考强度

- 现状：路由只决定物理模型，思考强度由 pi 的 `settings.modelThinkingLevels` 按 `provider/model` 给出。`models.complex` 与 `models.standard` 若指向同一个模型，就无法只靠强度区分两档，分类器升级对这次请求没有可见影响。
- 提议：在 `models` 旁新增每个槽位的思考强度，例如
  `"thinking": { "complex": "high", "standard": "medium", "implementation": "max" }`，
  由 `route()` 的 `thinkingLevel` 使用，优先级高于 `modelThinkingLevels` 的物理模型键、低于虚拟模型键。
- 需要一并处理：严格校验（合法值集合、`models.implementation` 为 `null` 时的语义）、`/jev-router status` 展示、
  决策条目里的 `requestedThinkingLevel`、中英 README 与 `jev-router.example.json`、配置夹具测试。
- 背景：2026-10 的 README 修订中选择了「只用 `modelThinkingLevels`」这一最小方案，此提议被推迟。
