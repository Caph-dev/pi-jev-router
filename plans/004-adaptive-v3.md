# 004 adaptive-v3：重新判定难度与切换模型的时机

状态：实施中。Roadmap：https://github.com/Caph-dev/pi-jev-router/issues/1
基线：`19e6c13`，`npm test` 275 tests，268 pass，7 skip（宿主测试未配置 `PI_ROUTER_HOST_MODULE`）。

## 用户决策（2026-10-31）

1. 允许从 complex 降级。
2. 分类输入强制包含最近对话。删除 `adaptive.contextMode`，等同原 `recent-conversation`。
3. 胜任度评估延后，记录在 roadmap issue。
4. v3 直接替换 adaptive-v2，不保留 v2 行为开关。commit + push，不发布 npm，不改 `package.json` 版本。
5. 不以省钱幅度驱动策略；不引入价格输入。

## 不变的部分

- `fixed` 策略的选模、交接与分类输入（`state.prompt`）保持不变，重试交接状态的后续修订除外；`shadow` 同样使用该重试行为。
- `shadow` 仍使用 fixed 路由，只是其后续检查所用的历史输入随第 2 条强制开启。
- 同一轮工具续接（`continuation`，无新压缩）保持当前模型。
- `retry` 粘滞：不分类、不交接、不处理待定压缩；同模型保留交接状态，不同模型锁定交接。
- `direct` 不读写状态。
- 取消、超时、分支切换后的迟到结果、classifier 用量账本的现有语义不变。
- 不通过模型名或价格推断能力。

## 配置变更

- 删除 `adaptive.contextMode`：从 `DEFAULT_CONFIG`、`ADAPTIVE_KEYS`、示例 JSON、README 中移除。旧配置写了它时按未知键告警并忽略。
- 新增 `adaptive.downgradeThreshold`：默认 `0.15`，范围 0–1，拒绝 null。合并完成后若 `downgradeThreshold >= threshold` 则启动失败，错误信息带配置路径。
- 新增 `adaptive.minDwellTurns`：默认 `2`，整数 1–20。含义：complex 至少服务了这么多个已评估的用户轮次之后，才允许降级。
- `historyMaxTurns`、`historyCharLimit` 保留，作为历史上限。

## 状态形态

`AdaptiveState.policyVersion` 新增 `"adaptive-v3"`，新写入一律为 v3。新增字段：

- `turnsInSlot: number`：当前槽位已服务的已评估用户轮次数。槽位变化时归零；每个新的已评估用户入口在决策前先对当前槽位加一。
- `lastCompactionEntryId: string | null`：当前分支上已处理的最新 compaction entry id。

迁移：v1/v2 及无 schemaVersion 的旧状态迁移为 v3 时，保留 model/slot/phase，`handoff` 锁定，`turnsInSlot` 设为 `minDwellTurns`，`lastCompactionEntryId` 设为当前分支上最新的 compaction entry id（没有则 null）。旧压缩不触发重判。新会话初始状态同样以当前分支最新 compaction id 初始化。校验函数接受 v3 字段并拒绝非法值。

## 决策点

“待定压缩”指当前分支上最新的 compaction entry id 存在，且不等于 `state.lastCompactionEntryId`。

优先级从高到低：

1. `direct`：同现状。
2. `retry`：同现状（粘滞）。不改变 `lastCompactionEntryId`。
3. `user` 且出现未评估的新用户入口：执行“用户边界决策”。同时把 `lastCompactionEntryId` 更新为分支最新值，压缩不再单独分类。
4. `user`/`continuation` 且有待定压缩：执行“压缩边界决策”，每个压缩 id 只分类一次。结果为 unavailable、timeout、invalid-answer、missing-input 时同样标记为已处理，并保持当前模型。
5. `continuation` 且满足交接条件：同现状的 guarded/first-write 交接。
6. 其他：保持。

用户边界与压缩边界都会调用分类器，complex 槽位也不再跳过分类。

### 用户边界决策

先对当前槽位执行 `turnsInSlot += 1`，再按分类结果查表。`p` 为 complex 概率，`complete` 为现有 `completeInput`（当前用户正文非空、无图片、未超 `promptLimit`）。

| 当前槽位 | p ≥ threshold | p ≤ downgradeThreshold 且 complete | 介于两者之间 | 分类不可用 |
|---|---|---|---|---|
| complex | 保持 complex | `turnsInSlot ≥ minDwellTurns` 时降到 standard，否则保持 | 保持 | 保持 |
| standard | 升到 complex | 保持 standard | 保持 | 保持 |
| implementation / retained | 升到 complex | 保持 | 保持 | 保持 |

交接重新启用：用户边界决策后，若结果槽位是 standard，分类有效，`p < threshold`，`p ≤ handoffThreshold`，`complete` 为真，且配置了 implementation 与非空 handoffTools，则 `handoff = "first-write"`，并写入 `handoffEvidence = { inputKey, probability }`；否则 `handoff = "locked"`，清除 handoffEvidence。`handoffPolicy: "first-write"` 时只要求结果槽位是 standard 且配置了 implementation 与 handoffTools。

### 压缩边界决策

不增加 `turnsInSlot`。使用当前投影重新构造分类输入。

| 当前槽位 | p ≥ threshold | p ≤ downgradeThreshold 且 complete | 其他 |
|---|---|---|---|
| complex | 保持 | `turnsInSlot ≥ minDwellTurns` 时降到 standard | 保持 |
| standard / implementation / retained | 升到 complex | 保持 | 保持 |

压缩边界决策后结果为 standard 时，无论是否降级，交接均按上一节规则根据本次结果重新评估。升级或保持 complex 时锁定交接。

### 边界与交接证据

- 槽位或模型发生变化时，沿用现有 `finish()` 逻辑：`stageSeq + 1`，`stageStartEntryId = leaf`。
- 交接只接受当前用户入口与 `stageStartEntryId` 之后的成功写入（现有 `hasSuccessfulWriteAfterBoundary`）。重新启用交接但模型未变时，同样把 `stageStartEntryId` 设为 leaf，保证旧写入不会触发交接。
- 交接执行时仍校验 `handoffEvidence.inputKey` 与当前输入一致（guarded）。
- 不再限制每条分支交接与升级的次数。

## 决策原因（decisionReason）

保留现有值，新增：`downgrade`、`hold-dwell`（满足降级概率但驻留不足）、`compaction-upgrade`、`compaction-downgrade`、`compaction-hold`、`compaction-unavailable`。诊断记录的 `policyVersion` 为 `adaptive-v3`。

## 验收（行为测试）

- 配置：默认值、示例 JSON 与 `DEFAULT_CONFIG` 一致；`contextMode` 告警并被忽略；`downgradeThreshold >= threshold` 启动失败；`minDwellTurns` 越界或 null 失败。
- complex 在驻留不足时遇到低 p 保持，驻留满足后降到 standard；降级后在新用户入口之后成功写入会交接到 implementation；降级前的写入不触发交接。
- 降级后再次遇到高 p 能升回 complex；同一分支可多次交接与升级。
- 分类不可用、输入不完整（图片、超长、空）时不降级。
- 压缩：每个 compaction id 只分类一次；retry 不分类且不消耗待定压缩；压缩与新用户入口同时出现只分类一次；迁移时已有的旧压缩不触发重判；压缩后 missing-input 保持模型；压缩边界可升级也可降级。
- 取消：分类中取消时不返回新状态；迟到结果不被采用。
- fixed 与 shadow 现有测试全部继续通过（shadow 中与 contextMode 相关的期望按强制历史更新）。
- 宿主测试使用 `PI_ROUTER_HOST_MODULE` 跑通，含一个真实 SessionManager 的压缩重判用例。

## 后续修订

2026-10-31：重试使用失败请求的同一模型时保留交接状态（用户决定）。
