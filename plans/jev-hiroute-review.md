---
template: doc
theme: blueprint
title: pi-jev-router 有限动态升级实施计划
subtitle: 默认保留 fixed；adaptive 有限升级、有界历史与本机真实 LLM 验收已完成。
lang: zh
source: 计划 001 · 基线 bb854b2 · 已核对 pi 1.2.0
---

本计划补全原方向审查，作为 M1/M2 实现与验收规格。后续 P1 的分类账和 fixed Codemode 支持修订见 [计划 002](./002-p1-accounting-fixed-codemode.md)，10 项真实复测已通过。第一版保留默认固定路由，增加显式启用的有限动态升级。短续接、分类失败和取消不会使已选强模型降级。升级后锁定规划阶段，避免重复执行首次写入交接。

## A 交付目标与范围

### 状态与执行约定

- 编号：001。沿用已有文件名，避免原 Markdown 与 HTML 链接失效。
- 状态：M1/M2、离线测试、真实 SessionManager 及本机 pi 1.2.0 在线 agent loop 验收已完成；未发布。真实调用、记账限制和证据见 [validation.md](./validation.md)。
- 优先级：P1。类别：direction、correctness、tests、docs。
- 工作量：L，拆为七个可验证步骤。风险：中。
- 完善日期：2026-10-16。规划基线：`bb854b2e8f91b70dfc95a0a679966d37dd3348fa`。
- 核对环境：Node.js `v24.15.0`，本机 pi `1.2.0`。
- 依赖：现有配置解析、虚拟模型接口、`node:test`；无需新运行时依赖。
- 2026-10-16 已按七步实现并更新 `plans/README.md`。原规格继续作为验收依据；下文基线记录不代表当前实现。

执行者先完整阅读本文，再执行漂移检查与基线测试。每步通过指定验证后进入下一步。不要自动 commit、push、发布或改写用户现有配置。

### 不可变约束

1. 默认策略为 fixed。保持基线选模和一次交接规则；2026-10-16 用户追加授权的 P1 将首次写入证据扩展为包含成功的 nested edit/write，见计划 002。
2. adaptive 与历史外发分别启用。动态路由不自动扩大分类输入。
3. 物理模型仍共用 provider，沿用 complex、standard、implementation、direct 槽位。
4. 不通过名称、价格或 contextWindow 推断模型能力；槽位由用户配置。
5. 保留配置文件优先级、未知键告警、thinking level 优先级和 limits 同步。
6. 状态只交给 pi 的分支状态机制保存。不用全局变量保存会话阶段。
7. 首次写入、工具成功、测试失败和模型自述都不是质量评价。

### 两项交付

**M1，步骤 1–5：有限升级。** 新用户边界重新判断；有复杂结果时升级至 complex。简单结果、输入不足或分类错误保持已有模型。保留初始规划的一次写入交接；动态升级后的阶段禁止自动交接。包含取消、重试、旧状态迁移、嵌套写入与决策记录。

**M2，步骤 6–7：可选背景与宿主验证。** 增加默认关闭的有界最近对话输入，完成真实 SessionManager 持久化与投影测试，编写宿主验收记录。自动评分、自动降级不属于 M2。

### 允许修改的文件

- `extensions/jev-router.ts`：配置、分类适配、状态归一化、决策辅助函数、注册入口。
- `test/route.test.ts`：扩展现有 stub，增加固定策略和有限升级回归。
- `test/config.test.ts`：新增字段、合并、默认值和非法值验证。
- `test/host-session.test.ts`：新增；使用真实 pi SessionManager 验证分支与投影。
- `jev-router.example.json`：继续完整列出所有默认值。
- `README.md`：中英文行为、隐私、配置、支持范围与验证说明。
- `plans/README.md`、本计划及对应 HTML：进度、证据和规格修订。
- `plans/validation.md`：新增；记录宿主版本、验证结果和未执行项。
- 2026-10-16 用户追加在线调用授权：`scripts/live-agent-smoke.ts` 和 `plans/live-smoke-results.json`，用于显式启用的真实调用及脱敏证据，不进入默认离线测试。

源码保持单文件结构。可提取同文件内部函数，不拆出新架构，不为测试导出生产内部状态。

M1/M2 原范围外：package.json、依赖与锁文件、RELEASING.md、LICENSE、用户配置、pi 宿主源码、凭据、跨 provider 槽位、自定义路由 DSL、新命令和 UI。后续 P1 仅追加 /jev-usage 命令与独立会话分类账；其他边界不变。仓库没有 typecheck/lint scripts；不要借本任务安装工具链。

## B 当前实现与验证环境

### 当前行为与代码锚点

`extensions/jev-router.ts` 是唯一扩展实现。第 118 行附近的 RouterState 仅保存 phase/model。第 287 行附近的 editedThisTurn 只识别最后一条 user 消息之后、外层工具名为 edit/write 的成功结果。

第 366 行附近的路由摘录：

```ts
if (request.reason === "direct") return route(direct);
const state = request.state;
if (!state) {
  const model = await choosePlanningModel();
  return route(model, { phase: "planning", model });
}
if (implementation && state.phase === "planning" && editedThisTurn(request.messages))
  return route(implementation, { phase: "implementation", model: implementation });
return pickState(state.model);
```

choosePlanningModel 在第 379 行附近优先复用 previous 中的规划模型。有状态时不重新分类。第 397 行附近截断最后一条 user 文本，第 429 行附近比较 `p(complex) >= threshold`，没有 confidence 门槛。

沿用 TypeScript、ESM、tab 缩进、双引号和现有错误前缀。配置范例是 mergeConfig 与 `test/config.test.ts`；测试使用 node:test、node:assert/strict，隔离临时目录并恢复环境。

`test/route.test.ts` 通过 stub 注册公开虚拟模型并调用 definition.route。扩充此入口，不测试复制的内部实现。现有示例配置测试必须继续成立：

```ts
assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), DEFAULT_CONFIG);
```

新增默认字段时必须同步示例 JSON。未发现额外项目 AGENTS、CONTEXT、ADR、设计规格或 CI 文件。

### 已验证与未验证

规划时基线 `npm test` 输出为 25 tests、25 pass、0 fail。离线 stub 验证了 fixed 的 Astra → Luna → Luna，分类调用一次；嵌套 write 被忽略；分类 error/aborted 在现有初始化路径回退 standard。

以上是规划基线。实施后配置与 route 共 149 项通过；配置真实宿主运行完整套件为 153 项通过，零 skip。经用户授权，codex-sub2api 的 sol/luna 与真实 Jev 完成 core/cancel/retry 共 8 项在线检查，core 最终 exit 0。尚未做准确率或缓存/成本收益对照。详细命令和限制见 [validation.md](./validation.md)。

### pi 1.2.0 契约

已核对虚拟模型文档、模型文档及相关类型和实现：

- reason=user 包括 prompt、steering、follow-up；continuation 也可能由扩展消息触发。
- previous 是最近成功响应；failed 是 retry 对应的失败物理模型和 assistant 消息。
- 新 state 在发送主模型请求前保存，主模型失败不撤回。原 state 引用或 undefined 表示保持。
- state 沿 session tree 继承并跨 compaction 保存；direct 没有 state。
- `ctx.sessionManager.getBranch()` 返回当前分支的持久 entry ID；getLeafId 返回当前叶节点。
- buildSessionProjection 返回 sourceEntry 与应用 context edits 后的 messages。已删除正文不在投影中。
- request.messages 可将摘要、custom message、bashExecution 转为 user role。按 role 过滤不能保证只取用户输入。
- 工具结果的 nestedCalls.calls 含 name、id、status；status 为 ok/error/unfinished。
- complete=false 可能表示参数省略、调用截断或未完成，不代表已记录的 ok 无效。
- 嵌套执行事件带 parentToolCallId；本实现消费持久结果，不新增事件缓存。
- classify 通常以 stopReason=error/aborted 报失败而非 reject；仍需防御第三方抛异常。
- 分类接口支持一次调用包含多个独立 questions，无需改为直接 HTTP 请求。

### 漂移检查与命令

在仓库根目录执行：

```sh
git status --short
git diff --stat bb854b2e8f91b70dfc95a0a679966d37dd3348fa..HEAD -- extensions/jev-router.ts test/route.test.ts test/config.test.ts test/host-session.test.ts jev-router.example.json README.md
git diff -- extensions/jev-router.ts test/route.test.ts test/config.test.ts test/host-session.test.ts jev-router.example.json README.md
git diff --cached -- extensions/jev-router.ts test/route.test.ts test/config.test.ts test/host-session.test.ts jev-router.example.json README.md
node --version
npm test
```

规划时只有 plans/ 未跟踪。若源码或宿主关键接口漂移，先对照本节摘录，不覆盖归属未确认的改动。文档进度变化无需阻塞实现。

验证入口：

- `npm test -- test/config.test.ts`：配置测试通过。
- `npm test -- test/route.test.ts`：公开 route 行为测试通过。
- `npm test`：完整离线套件通过；宿主专项默认可 skip，但须单独报告。
- `git diff --check`：无空白错误。
- `git diff --name-only` 与 `git status --short`：相对开始快照没有范围外改动，包含未跟踪文件。

npm 命令沿用现有 `test: node --test`，无需安装依赖。当前 Node 支持直接运行类型可擦除的 TS。目标环境若不支持，使用受支持的开发 Node 版本；不在本任务调整 engines 或添加转译器。不要声称跑过不存在的 lint/typecheck。

## C 配置与分类输入契约

### 配置默认字段

保留现有字段和值，增加：

```json
{
  "strategy": "fixed",
  "adaptive": {
    "handoffTools": ["edit", "write"],
    "decisionTimeoutMs": 3000,
    "contextMode": "last-user-only",
    "historyMaxTurns": 4,
    "historyCharLimit": 8000
  }
}
```

这里只展示新增字段。示例 JSON 必须保留完整配置。这些数值是初始工程预算，不是实测最优值。

- strategy 仅接受 fixed/adaptive，省略时继承；null、false、非法字符串均报带路径的错误。
- adaptive 省略时继承；显式值必须为普通对象，拒绝 null、数组和其他类型。
- handoffTools 为去重后的非空字符串数组；允许空数组禁用初始交接。数组按文件整项覆盖。
- 拒绝将 bash 或 codemode 加入 handoffTools。自定义工具由操作者确认其成功确实代表写入。
- decisionTimeoutMs 为 1–60000 整数；historyMaxTurns 为 1–8 整数；historyCharLimit 为 1–32000 整数。
- contextMode 仅接受 last-user-only/recent-conversation。新字段显式 null 不表示默认值。
- personal → project 按字段合并；显式配置文件仍独占。不修改 DEFAULT_CONFIG 或前层对象。
- 未知嵌套键仍告警并忽略。fixed 不消费 adaptive 字段，但解析仍验证它们。

实施顺序为 M1 的 strategy、handoffTools、decisionTimeoutMs，再实现 M2 的三个历史字段。当前均已生效，示例完整列出默认值。

### 分类结果与选模分开

新增内部 classifyComplexity，返回具名结果，不把所有失败折成 standard 模型 ID：

```ts
type ComplexityResult =
  | { kind: "classified"; probability: number; durationMs: number }
  | { kind: "unavailable"; reason: string; durationMs: number }
  | { kind: "cancelled"; durationMs: number };
```

unavailable.reason 实现为字符串字面量联合：disabled、missing-classifier、timeout、error、invalid-answer、missing-input。不把供应商原始错误正文写入持久状态或决策日志。

adaptive 仅接受 stopReason=stop、type=choice 且 complex 概率存在、有限、位于 [0,1]。缺失、NaN、Infinity、越界均为 invalid-answer。只使用 complex 概率，不另设 confidence 门槛，也不自行重归一化。

继续采用 `p(complex) >= threshold`，测试等于阈值及两侧。confidence 表示分布集中程度，不是独立正确率保证。不照搬 HiRoute 的 simple>=0.8。

fixed 保留原分类输出行为。若共用适配函数，先通过表征测试证明缺失概率、异常和 previous 处理未变。

### 取消与超时

- 调用前及返回后检查 caller signal，并向分类器传递 signal。
- caller 取消，或服务返回非本地预算导致的 aborted：中止 route，不返回新 state，不请求主模型。
- 本地 decisionTimeoutMs 耗尽而 caller 未取消：返回 unavailable/timeout。
- 用独立 AbortController、有限计时器和 race 保证上限；清理监听与计时器，处理迟到 rejection。
- 不能只发 abort 然后无限等待不响应取消的 provider。
- 分类完成至主模型发送之间的取消由宿主控制；state 已保存时遵守“不撤回”契约。
- retry 不重新分类，不重复消耗失败请求的分类预算。

### M1 默认输入

adaptive 从 buildSessionProjection().entries 找到当前分支最后一个 sourceEntry.type=message 且原始 message.role=user 的贡献，使用投影后纯 text。排除图片、thinking、toolCall。

“原生 user”指宿主 user 消息，可能由 SDK/扩展生成，不能保证人类手输。排除 custom_message、compaction、branch_summary、bashExecution、system。上下文扩展改写 request 内容时，默认仍使用可追溯的投影文本，并在 README 说明。

仅在 reason=user 且存在尚未判断的 entry ID 时分类。缺来源或正文为空时保持已有模型；首次无状态选 standard。不能改用转换后的最后一条 user 猜正文。

adaptive 的默认请求形态为 `state: { current: "截断后的文本" }`；questions.complexity 仍是 choice，instructions 指向 state.current。fixed 保留原 state.prompt 形态。promptLimit 沿用 JS string.slice 的 UTF-16 code unit 上限。状态与日志仅记 ID、长度、截断标志，不保存 prompt。

### M2 可选历史

contextMode=recent-conversation 时按原生 user entry 划分投影轮次，只加入当前轮之前最近的完整轮次。每轮仅含 user 与成功 assistant 的 text；成功指 stopReason 为 stop/toolUse。工具参数、结果、nestedCalls 参数、思考、图片、系统提示词和 error/aborted 响应均排除。

- 当前输入单列，截至 promptLimit。
- 历史从新到旧选择，最多 historyMaxTurns 轮，总文本长度不超过 historyCharLimit。
- 超预算时删除最早完整轮次；最近一轮本身过大则历史为空，不跳过它拼接更早碎片。
- compaction 裁掉的轮次不从原始 session 补回。context_edit 删除/替换前的正文不能重新外发。
- historyPartial 在压缩、裁剪、上下文编辑/删除、含失败或取消响应、完整性未知时为 true；不能据此扣模型表现分。
- JSON 使用 current 字符串、recentTurns 数组和 historyPartial 布尔值。每个历史轮次为 `{ user: string, assistant: string[] }`，按时间排列；不发送本地 entry ID。instructions 明确引用 state.current 与 state.recentTurns。历史字符也按 UTF-16 code unit 计数；预算指正文总量，不含固定 instructions 和 JSON 结构开销。
- last-user-only 只构造当前文本，无历史字段。classifier=null 时不外发。
- 不调用额外模型生成摘要。

助手文本可能复述文件内容或密钥。投影、过滤和预算不保证绝对防泄漏；README 应明确允许外发的文本来源。

## D 分支状态、迁移与写入证据

### adaptive 状态格式

保留 phase/model 以兼容回到 fixed，新增版本字段。建议形态：

```ts
interface AdaptiveState {
  schemaVersion: 1;
  policyVersion: "adaptive-v1";
  strategy: "adaptive";
  provider: string;
  phase: "planning" | "implementation";
  model: string;
  slot: "complex" | "standard" | "implementation" | "retained";
  stageSeq: number;
  stageStartEntryId: string | null;
  handoff: "first-write" | "locked";
  lastEvaluatedUserEntryId: string | null;
  configKey: string;
}
```

stageSeq 从 1 起，物理模型、phase 或 configKey 改变时加一；同一次 route 最多加一。仅更新 user ID 或锁定 handoff 不开新阶段。legacy 迁移从 1 起。同 ID 不同槽位可改 phase/slot，但不算物理切换。不存 Model、Set、Date、Error、AbortSignal 或正文。

configKey 是固定字段顺序的摘要字符串，覆盖 provider、models、threshold、promptLimit 和 adaptive 配置。不含凭据，无需加密；debug 和 virtual 展示字段不影响策略身份。

stageStartEntryId 使用 route 前的叶节点 ID。它是分支锚点，不是 messages 下标或时间戳。必须确认锚点在当前分支，只消费其后的证据。

### 初始化、迁移、恢复

- 新会话初始化 planning、stageSeq=1。仅在 reason=user、原生 user ID 与锚点均可用、implementation 非 null 且白名单非空时 first-write，否则 locked。将当前 user ID 记为 lastEvaluatedUserEntryId；复用 previous 或分类不可用也视为已处理，无 ID 则为 null。
- 初始分类不可用选 standard；caller 取消则不初始化。
- 初始化可复用同 provider 的 previous complex/standard，不调用分类器。不能复用 implementation 跳过规划。
- legacy {phase,model} 迁移：保留可用模型与 phase，slot 按 phase 与配置匹配；仍不明确则 retained。
- 迁移锚点设为当前 leaf，handoff=locked。新 user 可以升级；continuation/retry 不分类。
- adaptive → fixed：只消费 phase/model，恢复 fixed 规则；不自动恢复更早的便宜模型。
- configKey 变化：关闭旧交接资格，重建 locked 阶段并重设锚点。同 provider 且目录仍存在时保留模型，否则选 standard。保留已判断 user ID；只有不同的新 user ID 才进入重判，不追溯重评旧输入。旧 provider 下相同 ID 不是同一模型。
- 状态模型从目录消失：选 standard、phase=planning、slot=standard，并写回修复后的 locked 状态与新锚点。standard 也缺失则沿用带配置路径的错误。
- 未知 schemaVersion、非法 phase/model/计数器：明确报错并给恢复建议，不猜未来格式、不清空状态绕过。
- 锚点不存在：不消费历史编辑，保持模型并锁定；后续新 user 仍可升级。

归一化先在局部候选值中完成。分类取消时不返回候选迁移或重判状态。保持时返回原引用或 undefined；只有语义变化才返回新对象。

### 初始交接的证据

仅对初始 first-write 阶段生效：

1. reason 必须为 continuation。新 user 优先重判，不能先消费旧写入。
2. 当前原生 user ID 必须等于该阶段最近已判断 user ID；写入在这个 user 与阶段锚点之后。
3. 外层 toolResult 的 toolName 在 handoffTools 且 isError=false，算写入证据。
4. 或 nestedCalls.calls 含白名单 name 且 status=ok。外层 Codemode 失败不抹去已成功的内部写入。
5. error、unfinished、文字声称已写入、成功 bash/codemode 外壳都不算。
6. complete=false 时已记录的 ok 仍可作正证据；没有记录不能推出没有写入。不扫描参数或正文猜行为。
7. 重复结果不会重复交接，因为首个交接已改变 phase/handoff。

旧宿主缺 nestedCalls 时仅识别外层白名单。缺分支与投影能力时 adaptive 明确报不支持，fixed 仍可用。初始交接是保留的成本策略，不是已证明任务适合降级。

## E 路由状态机与处理顺序

### 优先级

1. direct：沿用 direct → implementation → standard，无状态、不分类。
2. fixed：进入原路由，不执行 adaptive 迁移和历史输入。
3. adaptive：检查 signal、宿主能力，在内存校验和归一化状态。
4. retry：执行失败恢复后结束，不分类、不交接。
5. 无初始化状态：进入规划；非 user 且无合规 previous 时选 standard，不从摘要猜任务。
6. 新 user：执行升级规则并记录判断过的 ID。
7. continuation：仅允许初始 first-write 交接，其余保持。

不能先清空 state 再调用旧 choosePlanningModel。

### 新 user 升级规则

- 同 entry ID 已判断：不分类、不改变阶段。不同 ID 即使文本相同仍是新请求。
- 已在 complex 槽位：不分类，更新用户边界并关闭尚未使用的初始交接资格。
- 其他槽位：绕过 previous 捷径，调用 classifyComplexity。
- 有效 p>=threshold：解析 complex 目标后进入 planning、handoff=locked 的新阶段。
- p<threshold、缺输入、disabled、缺分类器、timeout、error、invalid-answer：保持模型，不切 standard 或 implementation。
- caller 取消或非预算 aborted：中止 route，不消费 user ID，不生成新阶段。
- 正常结束的重判无论是否升级，都关闭旧 first-write，防止“继续”引发遗留降级。
- unavailable 也标记该 user 已尝试；同 ID 不重复，下个新 ID 可重试。
- complex 与当前物理模型相同：锁定 planning，不计物理切换。
- 有效状态存在但 complex 目标缺失：保持模型并记录 target-missing；首次选择目标缺失仍报配置错误。

因此“继续”“按第二方案做”即使分类简单，也不降低当前能力。last-user-only 仍可能漏掉隐含复杂需求；M2 改善背景，不保证消除误判。

### retry

优先采用 failed 物理模型和 thinkingLevel。failed 必须属于当前 provider、仍在目录，且为配置槽位或有效状态模型；否则用有效状态模型，再回退 standard。

- failed 与 state 同模型：不增阶段、不重新分类。
- failed 不同但合规：写回 failed 模型并建立 locked 阶段，避免 continuation 跳回。
- failed 缺失：有状态就保持；无状态复用合规 previous，否则 standard，并建立 locked 状态。
- 所有 retry 都关闭待执行的 first-write；相同模型可只改 handoff，不增 stageSeq。
- 不按错误文本自动推断模型能力；限流、网络、context overflow 的换模恢复后置。

普通路由保持虚拟级别 → 物理级别 → request.thinkingLevel 优先级。retry 有 failed.thinkingLevel 时采用它，否则沿用普通优先级。所有路径同步 limits。

### 轨迹与切换上界

```flow LR
初始规划 -> 实现模型: 初始阶段成功写入
初始规划 -> 锁定强规划: 新用户要求复杂任务
实现模型 -> 锁定强规划: 新用户要求复杂任务
锁定强规划 -> 锁定强规划: 续接或简单请求
实现模型 -> 实现模型: 简单结果或分类不可用
```

固定配置、无模型消失和外部切模时，每条分支最多一次初始交接，再一次升级。升级先发生则取消交接。这个结构限制来回切换，第一版不增加驻留时间或切换预算。

代价是升级后可能长期使用 complex。用户可开新会话或改回 fixed；本版不自动检测任务结束并降级。

### 最小决策记录

debug 时每个 route 输出结构化摘要：strategy、policyVersion、requestReason、stageSeq、from/to、decisionReason、classifierStatus、有效 probability、classifierDurationMs、switched。不输出正文、工具参数或原始服务错误。

decisionReason 使用稳定枚举，例如 initial、previous-reused、initial-write、upgrade、keep-simple、keep-unavailable、already-evaluated、retry-sticky、state-recovered、target-missing、direct。默认 debug=false，不增加文件日志或遥测。

有 usage 时记录数值 token/cost；未知价格记 unknown，目录零报价不能解释为免费。本机 pi 1.2.0 实测扩展直接 classify 的 usage 未计入 /session；P1 已用公开 appendEntry 持久化独立分类账并提供 /jev-usage 查询。压缩 usage 正常计入。升级宿主后重新核对，不能套用 Codemode 费用累加行为。

## F 实施步骤与回归清单

### 步骤 1：固定当前行为与测试入口

扩充 `test/route.test.ts` 的 Definition、register、context、request stub，支持 classifier 调用计数、signal、branch/projection 和有效物理模型对象。增加 dispatch helper 模拟“返回 state 先保存，再发送请求”；原引用不新增记录。

先添加 fixed 表征测试，不改路由行为。fixture 使用真实字段；测试模拟器不能当作真实宿主证据。

**验证：** `npm test -- test/route.test.ts` → 原测试与 fixed 新用例通过；`npm test` → 0 fail。保留原有 25 项，记录新增计数。

### 步骤 2：加入策略配置与版本状态

修改 RouterConfig、DEFAULT_CONFIG、CONFIG_KEYS、mergeConfig，增加 M1 配置、未知键检查和测试，同步 example。实现内部 normalizeAdaptiveState 与分支锚点辅助函数，fixed 路径不变。

首次 adaptive route 检查 getBranch、getLeafId、buildSessionProjection 能力。错误指向 fixed 或升级宿主，不自动改依赖。

**验证：** `npm test -- test/config.test.ts test/route.test.ts` → 合并、非法值、迁移与 fixed 兼容通过；example 深比较通过。

### 步骤 3：实现分类结果与有限升级

加入 classifyComplexity 和 adaptive 选模。新 user 直接调用分类适配，不清空 state 触发初始化。实现来源过滤、ID 去重、超时、signal、答案校验和 target-missing 保持。

先添加对应失败用例，确认失败来自未实现行为，再实现到通过。超时用受控 fake promise/计时器测试，不等待真实 3 秒。

**验证：** `npm test -- test/route.test.ts` → 复杂请求升级；简单/错误保持；取消 reject 且状态写入次数不变；同 ID 分类最多一次。

### 步骤 4：初始交接、retry 与恢复

实现内部 hasSuccessfulWriteAfterBoundary，按 D 节读取持久工具结果和 nestedCalls。retry 位于交接前。补齐 failed 模型、thinking、配置变化、目录缺失和锚点丢失。

locked 阶段永不进入交接分支。模拟“返回新状态后主模型失败”，retry 不回滚、不重复升级。

**验证：** `npm test -- test/route.test.ts` → 嵌套成功、外层失败、旧编辑排除、升级锁定、retry、分支隔离通过；`npm test` → 全部离线测试通过。

### 步骤 5：决策记录与 M1 文档

增加结构化 debug 摘要和字段白名单测试。README 中英文区分 fixed/adaptive；修正 low confidence 必回退的承诺，将“保证一次 cache miss”改为“限制切换次数，缓存效果取决于 provider”。

说明 fixed 基于转换后的最后一条 user，可能包含宿主注入内容；adaptive 使用来源投影。保留 classifier=null 的关闭说明。

**验证：** `npm test` → 全部通过；`git diff --check` → 无输出。用敏感哨兵断言日志不含输入、参数或原始服务错误。此时 M1 可标记离线验收通过。

### 步骤 6：默认关闭的有界历史

新增 M2 配置，内部 buildClassifierInput 按投影组织 current/recentTurns/historyPartial。提示明确字段含义，输入是待判断材料，不能改变标准。不另发摘要模型请求。

仅 adaptive+recent-conversation 扩大输入；fixed 与 last-user-only 保持各自 payload 契约。同步 README/example。

**验证：** `npm test -- test/config.test.ts test/route.test.ts` → 预算、整轮裁剪、隐藏正文排除和默认 payload 不扩张通过；`npm test` → 全部离线测试通过。

### 步骤 7：真实宿主状态与验收记录

新增 `test/host-session.test.ts`，由 PI_ROUTER_HOST_MODULE 指向宿主公开入口并动态 import。使用公开 SessionManager 创建临时 session，不修改用户会话。未设变量则具名 skip；设了但导入失败必须 fail。

已核对公开入口导出 SessionManager，支持 create、open、inMemory；实例支持 appendCustomEntry、appendContextEdit、appendCompaction、branch、getBranch、buildSessionProjection。执行时再对照版本签名。用 `appendCustomEntry("pi.virtual-model-state", { provider, modelId, state })` 构造真实分支状态记录；provider/modelId 是虚拟模型身份。测试 JSON 持久化、重开、分支、context edits、compaction 投影，再将真实数据交给公开 route。不调用私有方法，不把手工 append state 描述为真实 agent loop 验证。

本机入口与拟新增测试的执行方式：

```sh
PI_ROUTER_HOST_MODULE=/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js npm test -- test/host-session.test.ts
```

上述命令已执行：4 tests、4 pass、0 fail、0 skipped。其他机器先定位自己的安装入口。测试构造持久记录，不代表真实 agent loop smoke。

在 `plans/validation.md` 分别记录单元测试、真实 SessionManager、真实 agent loop smoke。后者使用隔离 cwd/config/session，按下列顺序验证：

- 选择 jev/auto，初始规划后执行真实 Codemode 内部 write，观察下一 continuation。
- 新复杂请求触发复杂结果后升 complex，随后写入仍保持。
- 取消分类确认未发主模型；失败后 retry 使用 failed 模型。
- resume、fork、compaction 后确认状态与用户去重。
- 核对分类 usage 是否计入 /session，是否重复记账。

**验证：** 宿主专项命令 → 0 fail、0 skipped；`npm test` → 全部通过；`git diff --check` → 无输出。在线 smoke 记录版本、步骤、实际选模序列；缺连接时标 blocked，不影响独立离线实现状态。

### 回归矩阵

用具名 it 或带 case ID 的表驱动测试。断言模型、phase、handoff、stageSeq、分类次数、状态写入次数；不能只断言不抛错。

- **T01–T06 fixed：** 默认不变；阈值边界；previous 复用；成功/失败外层编辑；后续 user 不分类；direct 优先级与缺失模型。
- **T07–T12 升级：** implementation→complex；standard→complex；复杂任务后继续；simple 保持；previous 不阻止重判；相同 ID 去重及不同 ID 同文本。
- **T13–T19 失败：** disabled、分类器缺失、error 返回、抛异常、缺失/错型答案、非法概率、timeout。分别验证初始化回退与已有状态保持。
- **T20–T24 取消：** 调用前、执行中、返回后 caller abort；服务自行 aborted；超时与 caller 同时发生时 caller 优先。迟到结果不写状态或未处理 rejection。
- **T25–T31 交接：** 外层 ok、nested ok、nested error/unfinished、外层 error 加 nested ok、complete=false 加 ok、成功脚本不算、空白名单或 implementation=null 禁用。
- **T32–T36 边界：** 阶段前旧编辑；新 user 优先；升级后写入保持；锚点丢失保持锁定；普通 continuation 不重复持久化。
- **T37–T42 retry：** failed 同模型、failed 不同合规模型、无 failed、无效 provider/模型、升级保存后失败、无状态 retry 不分类。另断言 thinking 与 limits。
- **T43–T49 迁移：** legacy 两阶段、槽位同 ID、旧模型缺失写回、standard 缺失、配置/provider 变化、未知 schema、adaptive→fixed。
- **T50–T56 输入：** 原生 user 投影、摘要/custom/bash 排除、默认无历史、整轮预算、超大最近轮、context_edit、工具/thinking 哨兵排除。
- **T57–T60 宿主：** 保存重开、不同 leaf 恢复、compaction 保持 state 并裁输入、投影与 edits。必须跑真实宿主专项。

ID 表示覆盖类别，可包含多个测试；不以“恰好 60 tests”为完成标准。

## G 完成标准、停止条件与维护

### M1 完成标准

- [x] 步骤 1–5 和 T01–T49 对应离线用例通过。
- [x] npm test exit 0，保留原有 25 项，无失败改 skip。
- [x] 默认 fixed 与基线一致；adaptive 简单/失败重判不降级。
- [x] 初始交接与升级锁定有可读轨迹断言。
- [x] example 与默认配置完全一致，中英文说明一致。
- [x] git diff --check exit 0，相对开始快照无范围外变更。

### M2 完成标准

- [x] T50–T56 通过，历史默认关闭，预算与来源有 payload 断言。
- [x] 宿主专项 exit 0 且零 skip，T57–T60 使用真实 SessionManager。
- [x] validation.md 明确记录真实 agent loop smoke 是否完成。
- [x] plans/README.md 分别记录实现、离线验收、宿主专项、在线 smoke。
- [x] Markdown/HTML 同步，剩余限制清晰可见。

### 本机在线验收

- [x] 最终 core 的真实 Jev p=0 初始 sol 规划、Codemode nested write 后交接 luna，每次请求前磁盘状态与路由一致。
- [x] 真实 Jev p=1 升级 complex/stage3，后续写入和简单请求保持锁定。
- [x] caller 取消真实分类后无主调用；注入 503 后宿主 retry 保持 failed 模型和强度。
- [x] 重建 SDK session 的扩展续接、真实 compaction、祖先 fork 均保持各自持久阶段与用户边界。
- [x] 直接分类未计入 /session 的宿主限制已实测并记录，脱敏证据见 live-smoke-results.json。

以上覆盖本机 pi 1.2.0 和获准 provider，不代表所有宿主或交互式 UI 兼容。若未来在线 smoke 未完成，可提交实现供审阅，但不满足在线发布验收。自动 commit/发布不属于计划。

### 停止并报告

- 关键源码已漂移且无法确认已有改动归属。
- 目标宿主缺分支/投影语义，或 ID 重用会把另一条记录误认成旧边界；不要改宿主绕过。锚点单纯缺失按 D 节保守锁定处理，不因此扩大实现。
- 用户消息在 route 时没有持久来源，无法可靠识别边界；提供复现，不能改用全文 hash 猜。
- nestedCalls 无法保留成功写入状态；先缩小复现并修订兼容声明。
- 需要新增依赖、改 engines、扩大 provider 格式或触及范围外文件。
- 同一关键验证经两次针对性修正仍失败；保留输出，不删测试。
- 在线缺连接或获准使用的测试材料；只阻塞在线部分，继续离线工作。

### 维护与回退

strategy=fixed 并重启即可配置回退。新会话得到基线轨迹；旧 adaptive state 的 phase/model 继续读，不自动回到更早阶段。

不修改历史会话、不批量删 state。未来 schema 显式迁移，不复用版本号改变字段含义。变更模型、handoffTools、contextMode 时覆盖重建状态测试。

升级 pi 后重跑 T57–T60 和 Codemode smoke，重点检查投影、nestedCalls、取消与保存时机。阈值、提示词和概率校验变更要更新 policyVersion 与评测记录。

单元测试验证控制流，真实任务验收判断质量，provider 缓存统计判断成本，三者不能替代。

## H 后续实验与参考资料

### 有限升级的实际收益

M1/M2 后，在单独授权的任务集比较 fixed、adaptive、全程 complex。初始设计为六类任务，各策略重复两次，共 36 次；这是拟定预算，未执行。

覆盖简单修改、跨文件设计、短指代、用户纠错、正常开发中的工具失败、长会话压缩。提前写独立验收条件，从相同快照开始，固定模型版本、工具与 thinking。调优集与验收集分开。

记录通过率、误降级、升级救回、耗时、返工、切换次数、分类延迟、分类和主模型 usage、缓存统计。直接 classify 费用单独核对，避免漏算或双算。未知价格不填零。

进入下一阶段的最低条件：离线规则无违规，试点通过数不低于 fixed，存在可复核升级收益，成本增长可解释。小样本仅支持继续试验，不证明统计优越。长期锁强若没有收益，记录失败再调整方案。

### 阶段评价仅做影子实验

阶段评价保留为后续实验，当前不得接入生产选模。它依赖原定目标、验收条件和稳定检查点；仓库尚无可信生产接口提供这些数据。

脱敏样例定义 assessmentTarget：stageId、branchId、turnIds、objective、acceptanceCriteria、policyVersion、evidenceComplete。目标和标准在阶段开始时冻结；新增要求属于下一阶段，不能倒扣旧阶段。

一次 classify 独立询问 complexity、performance、evidenceSufficient。performance 有明确低/中/高锚点，代码组合结果，仅在阶段匹配且证据完整充分时采用。historyPartial 与 evidenceComplete 分开，记录缺失不等于做错。

样例至少包括成功、明确遗漏、缺产出、一次正常测试失败、反复无进展、新增目标、换模型修复、provider 限流。记录人工判定、输出、误报/漏报，在保留集验证。先只记录，不影响 route。

未来交付 `plans/stage-assessment-experiment.md`，包含样例协议、预算、评价、结果和是否实施的结论。它不是本次必须生成的伪结果。证明信号有用并选定可信检查点后，另写自动升级/降级实现计划。

检查点不能来自任意成功 bash、自称完成或一次失败。若采用宿主事件，必须写清事件名、参数、分支持久化与恢复契约。

### 明确后置

任务类别分支、每槽位 provider/id、多 provider 故障转移、可编辑分类标准、自动任务结束检测、自动降级和完整胜任度评分，均不进入本次产品变更。

不采用结构化输出保证正确、confidence 等于正确率或文章收益可迁移的假设。文章约 92% 成本节省来自特定模型与任务，本仓库没有对应实验。

### 参考资料

- [HiRoute 实践](https://aliyun.github.io/ai-agent-handbook/cases/jev/hiroute.html)：任务判断、阶段表现与代码路由分工。
- [Jev 深度解析](https://aliyun.github.io/ai-agent-handbook/cases/jev/deep-dive.html)：结构化判断和不确定性。
- [TypeSafe Confidence](https://docs.typesafe.ai/confidence)：概率分布与集中程度。
- [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)：共享上下文、独立问题、代码组合。
- 已安装 pi 的 docs/virtual-models.md、docs/models.md、docs/extensions.md：路由、分类与嵌套工具契约。
- 已安装 pi 的 dist/core/session-manager.d.ts、dist/core/virtual-models.d.ts、dist/core/nested-tool-calls.js：投影、持久 ID、状态与嵌套记录。

宿主版本以现场为准。本文内联实现所需的关键契约；文章提供动机，不覆盖状态机与验收规则。
