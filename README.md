# pi-jev-router

**English** · [简体中文](#中文文档)

[![npm version](https://img.shields.io/npm/v/@caph42/pi-jev-router)](https://www.npmjs.com/package/@caph42/pi-jev-router)
[![license](https://img.shields.io/npm/l/@caph42/pi-jev-router)](LICENSE)

A [pi](https://pi.dev) extension that registers one virtual model, `jev/auto`, and routes agent-loop requests across three configured physical model slots: complex, standard and implementation.

Direct requests such as compaction and titles use `models.direct` when set, otherwise `implementation`, then `standard`. It never infers a model's capability from its name or price.

## What it does

A session rarely needs the same model for every step. `jev/auto` gives pi one selectable model and keeps the routing policy in the extension:

- **`fixed`** (default) classifies the current native user message at initialization or reuses an available previous planning model, plans on complex or standard, and hands implementation to `models.implementation` after the first successful write.
- **`adaptive`** adds a guarded handoff and can upgrade later native user input to complex when the classifier is confident.
- **`shadow`** follows fixed's real route and only reports when it would recommend an upgrade.

For the default `fixed` strategy:

```text
current native user message at initialization
       │
       ▼
   classify
    ├─ complex   → models.complex ──┐
    └─ otherwise → models.standard ─┤
                                    └─ successful write (edit/write) → models.implementation
```

An eligible previous planning model is reused before classification.

## Install

```sh
# install the published release
pi install npm:@caph42/pi-jev-router

# or pin a release
pi install npm:@caph42/pi-jev-router@1.0.1

# or load a checkout in place, without installing
pi -e ./extensions/jev-router.ts --model jev/auto
```

Then choose **Auto (Jev)** in `/model`, or start with:

```sh
pi --model jev/auto
```

Upgrade with `pi update --extensions`. Do not load a local checkout and the installed npm package at the same time: both register `jev/auto`. Installing the package does not change an existing `jev-router.json`.

### Requirements

- Pi with virtual models, persistent branch IDs and `buildSessionProjection()`. Verified against Pi 1.3.0.
- The complex and standard models, plus any configured `models.direct`, must resolve through `pi --list-models`. The defaults are `openai-codex` models: `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`.
- Optional classifier credentials. The default is TypeSafe's `typesafe/jev-latest`; any model of pi's `classifier` type works, including Cloudflare's Clef, a `llama.cpp` router and OpenAI's Decisions API (see [Classifier endpoints](#classifier-endpoints)). Set `classifier` to `null` or `false` to disable classification.
- A Node version supported by the installed Pi. This release's native TypeScript tests ran on Node 24.15.0.

Without projection support, `fixed` and `shadow` send no classifier input and cannot recognize writes; initialization can still select the standard slot or reuse a previous planning model. `adaptive` requires the projection APIs.

## Quick start

The default `fixed` strategy works with an OpenAI Codex login. To try adaptive routing with durable diagnostics, create `~/.pi/agent/jev-router.json`:

```json
{
  "strategy": "adaptive",
  "diagnostics": { "record": true }
}
```

The Codex login covers the default physical models; the default classifier needs TypeSafe credentials. Without a usable classifier, adaptive has no classification evidence: it reuses an available planning model or starts on `standard`, and cannot authorize guarded handoff or classifier-driven upgrades.

Everything else stays at the defaults below. Restart Pi after changing configuration.

## Strategies

| Strategy | Initial planning | After a successful write | Later native user input |
| --- | --- | --- | --- |
| `fixed` (default) | Classify the current native user message once at initialization, or reuse an available previous planning model | Hand off to `models.implementation` | Keep the current model |
| `adaptive` | Same selection; guarded handoff by default | Hand off only with simple-input evidence and bounded context | Upgrade to complex when the probability reaches `threshold`, then lock |
| `shadow` | Same as fixed | Same as fixed | Assess an upgrade and report it without applying it |

Initial classification unavailability selects `standard`; later unavailability keeps the current model. A selected initial model or direct target missing from the catalog is a configuration error. A missing handoff or upgrade target keeps the current model; a missing persisted model is repaired to `standard` and saved with handoff locked. A missing `standard` model is also a configuration error.

All strategies use bounded classification, zero SDK retries, native projected input and retries that stay on the failed physical model. Cancellation aborts routing without returning candidate state. Direct requests bypass classification and state, but respect cancellation.

## Configuration

### Where configuration comes from

| Source | Scope |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | Explicit file. When set, no other file is read. |
| `~/.pi/agent/jev-router.json` | Personal configuration. `$PI_CODING_AGENT_DIR` relocates the `~/.pi/agent` directory. |
| `<project>/.pi/jev-router.json` | Project configuration, merged over the personal file. |

Nested objects merge; arrays replace. Missing files are allowed; malformed files fail. Unknown keys warn and are ignored. Configuration is read when Pi starts, so restart Pi after editing it. [`jev-router.example.json`](jev-router.example.json) contains every default.

### Core routing

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `fixed` | `fixed`, `adaptive` or `shadow` |
| `provider` | `openai-codex` | Provider containing the physical slots |
| `models.complex` | `gpt-6-astra` | Demanding work |
| `models.standard` | `gpt-6.1-sol` | Ordinary planning and initialization fallback |
| `models.implementation` | `gpt-6-luna` | Execution; `null` or `false` disables handoff |
| `models.direct` | `null` | Direct requests; follows `implementation`, then `standard` |
| `classifier.provider` | `typesafe` | Classifier provider; set `classifier` to `null` or `false` to disable classification |
| `classifier.id` | `jev-latest` | Classifier model id |
| `classifier.temperature` | unset | Divides label logits before normalizing, greater than 0 and at most 100; read only by adapters that rank label probabilities, ignored by the rest |
| `classifier.timeoutMs` | unset | Local deadline for one classifier call, an integer from 1 to 60000; overrides `adaptive.decisionTimeoutMs` when set |
| `threshold` | `0.5` | Probability at or above this value selects complex |
| `promptLimit` | `16000` | Current text budget in UTF-16 code units |
| `adaptive.decisionTimeoutMs` | `3000` | Local total classifier deadline, an integer from 1 to 60000; applies to **all** strategies |

### Classifier endpoints

`classifier.provider` and `classifier.id` name any model of pi's `classifier` type; the router does not parse endpoint formats itself, so the catalog decides which adapter a model uses. The four adapters and their requirements:

| API | Example model | Credentials | Notes |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | Default. The direct model has no catalog price, so `/jev-usage` keeps reporting its cost as unknown. |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | Also serves Jev models on Workers AI. |
| `llama-cpp-classify` | a chat model of a `llama.cpp` router | Pi's `/login llama.cpp` connection, with an optional server API key | Requires llama.cpp's native `/tokenize`, `/apply-template` and `/completion` endpoints. Renders the state twice; allow time for tokenization, templating and probability readout with `classifier.timeoutMs`. Raw label probabilities are often overconfident; `classifier.temperature` above 1 softens them. |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | A ChatGPT login through `/login` does not supply this key; log out of `openai` to use the key. |

Models on `openrouter`, `vercel-ai-gateway` and `opencode` proxy the System One format and use their own provider's credentials. A classifier that is missing from the catalog yields `missing-classifier`, and any adapter error yields `error`. When no previous planning model can be reused, initialization falls back to `standard`; later failures keep the current model. Neither failure authorizes a guarded handoff. Switching classifier, model or `classifier.temperature` changes probability calibration, so re-check `threshold` rather than assuming the previous value transfers.

### Adaptive routing

| Field | Default | Meaning |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`, or explicit legacy `first-write` |
| `adaptive.handoffThreshold` | `0.2` | Maximum complex probability for guarded handoff, range 0–1 |
| `adaptive.maxHandoffContextTokens` | `50000` | Positive safe integer; guarded handoff requires a known estimate no larger than this |
| `adaptive.handoffTools` | `edit`, `write` | Successful write tools eligible for adaptive handoff |
| `adaptive.contextMode` | `last-user-only` | Or opt-in `recent-conversation`; used by adaptive classification and shadow reassessments |
| `adaptive.historyMaxTurns` | `4` | Prior complete turns, an integer from 1 to 8 |
| `adaptive.historyCharLimit` | `8000` | History text budget, an integer from 1 to 32000 UTF-16 code units |

### Virtual model and diagnostics

| Field | Default | Meaning |
| --- | --- | --- |
| `virtual.provider` | `jev` | Provider the virtual model is listed under |
| `virtual.id` | `auto` | Model id, so the default selection is `jev/auto` |
| `virtual.name` | `Auto (Jev)` | Display name in `/model` |
| `virtual.thinkingLevels` | `low`, `medium`, `high`, `xhigh`, `max` | Offered thinking levels |
| `virtual.contextWindow` | `272000` | Initial advertised context window; routes adopt the physical model's limits |
| `virtual.maxTokens` | `128000` | Initial advertised max output; routes adopt the physical model's limits |
| `diagnostics.record` | `false` | Persist sanitized decision and main-request outcome entries |
| `debug` | `false` | Structured routing metadata on stderr; also `JEV_ROUTER_DEBUG=1` |

The global classifier deadline keeps its original `adaptive.decisionTimeoutMs` name for compatibility. No optimal latency or cost claim is attached to the 3000 ms default. The handoff guard fields affect adaptive only. `fixed` and `shadow` use `edit`/`write`, including successful nested records. An empty `adaptive.handoffTools` disables adaptive handoff. `bash`/`codemode` cannot be whitelisted, and wrapper success is not write evidence; custom tool names must represent a write when successful. New `strategy`, `adaptive` and `diagnostics` fields reject explicit `null` and invalid values, as do `classifier.temperature` and `classifier.timeoutMs`; omitting a classifier option keeps the inherited value. The existing `null`/`false` conventions for model slots and `classifier` remain intact.

## How routing works

### Initial selection

On initialization, the router reuses an available previous planning model (complex or standard) on the configured provider; otherwise it classifies the current native user message once. A valid probability at or above `threshold` selects `models.complex`; everything else selects `models.standard`. If classification is unavailable, the request uses `standard`. Later classification failures keep the current model.

Initial classification locates the last native source entry whose original role is `user` and uses its projected visible text as the current input. Converted custom messages, summaries and bash output do not replace that source. A native user entry may originate from an SDK or extension; it does not establish human authorship. Request-local context transforms do not replace the persistent projection used for classification.

### Handoff and upgrade

Guarded adaptive handoff requires all of the following:

1. The initial slot was `standard`, with a valid complex probability below `threshold` and at most `adaptive.handoffThreshold`. Reusing a previous model provides no classification evidence.
2. Current native projected text is nonempty, untruncated and has no image. The effective classifier input still matches the input used for the decision; only its SHA-256 digest is stored in state.
3. A successful whitelisted write follows both the current native user entry and the stage anchor.
4. The current context-token estimate is finite, nonnegative and within `adaptive.maxHandoffContextTokens`.
5. The implementation model remains available.

Initial complex selection is locked under guarded policy. Disabled or missing classification, invalid answers, errors and timeouts never authorize guarded handoff. A new user assessment invalidates an initial handoff that has not been used. Each new native entry ID is assessed at most once; identical text with a new ID is a new request. Complex slots skip further assessment. A later upgrade enters locked planning. Under unchanged configuration and catalog, a branch has at most one initial handoff and one upgrade. There is no task-end detection and no automatic return from complex to the implementation slot.

To retain the original first-write handoff behavior, set the policy explicitly:

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` permits handoff even after initial complex selection or classification unavailability, without the simple-input and context gates. Subsequent upgrades still lock planning.

A successful entry in `nestedCalls` with status `ok` counts even if the outer tool later failed or its record is incomplete. It proves a completed write, not completion of the overall task. Failed or unfinished nested calls, tool arguments, prose saying "written", and successful wrappers do not count. Native branch boundaries prevent old writes from triggering the current handoff. Hosts without nested records can recognize only successful outer writes.

### Retries, cancellation and deadlines

Retries never classify or hand off. They prefer an available failed model on the configured provider and in the configured slots or current state, preserving its thinking level. Otherwise they use valid state, an available previous planning model or `standard`. Retry locks any remaining handoff eligibility; repeated retries do not append identical state. Pi persists returned state before main dispatch, so a later model failure does not undo it.

All strategies use a bounded classifier call with zero SDK retries. `adaptive.decisionTimeoutMs` is the total local deadline and applies to every strategy; `classifier.timeoutMs`, when set, replaces it for classifier calls only. A deadline win ignores late success or failure. Caller cancellation or a service abort terminates routing without returning candidate state. Direct requests bypass classification and state, but still respect cancellation.

### State and migration

Adaptive state uses `schemaVersion: 1` and `policyVersion: "adaptive-v2"`. Legacy phase/model and adaptive-v1 states migrate with handoff locked. Configuration or provider changes and lost anchors close old handoff eligibility. Unknown schemas fail with recovery advice. `fixed` can consume adaptive phase/model state; explicitly switching to `fixed` restores fixed's handoff policy. Fixed state records the provider, handoff lock and stage anchor. State follows resume, compaction and branch ancestry; a new session starts the policy anew.

## Shadow mode

`shadow` follows fixed's physical routing and initial prompt-only classification. On later native user requests below the complex slot, it uses the adaptive input scope to suggest keeping the current model or upgrading. It logs `proposedModel`, `available` and `applied=false` on stderr even when `debug` is off. It does not simulate a separate adaptive branch or prove quality or cost gains. The last assessed entry ID is persisted to avoid duplicate calls after reopen. Retry and continuation do not perform shadow classification.

## Diagnostics and usage

With `diagnostics.record: true`, `pi-jev-router.decision` entries include routing reasons, physical source and target models, requested thinking level, `classifierStatus`, the classifier adapter (`classifierApi`), probability, duration, safe usage and context estimate. A random `decisionId` links a finalized main assistant response to its `pi-jev-router.outcome` entry, including actual thinking level, stop reason, failure category, reported usage and elapsed time after routing. Missing outcomes remain missing; this is not an HTTP log or a first-token latency measurement. Direct calls do not create decision or outcome records. Session and branch ancestry is checked before recording outcomes, and pending associations are cleared at session and agent boundaries. Classifier results arriving after a deadline or after an invalidated session, branch or input are not applied.

Diagnostics and classification records exclude prompts, code, tool arguments, response bodies, credentials and raw errors. Persistence errors emit only `diagnostics-unavailable` and never alter routing; a failed write can leave usage incomplete or pending. Diagnostics are excluded from model context and are not an additional billable usage source. Do not add outcome usage to Pi's own session totals.

### `/jev-usage`

| Command | Scope |
| --- | --- |
| `/jev-usage` | Current branch |
| `/jev-usage --session` | All entries in the current session file, including abandoned branches |
| `/jev-usage --json` | Structured output |

Queries call no model and do not change state. The public `summarizeClassifierUsage(manager, virtual?, scope?)` export provides the same data; its `apis` field lists the distinct classifier adapters among the recorded attempts.

Each actual classification attempt has a random call ID, a pending snapshot and a terminal snapshot. Snapshots count once; real reattempts after cancellation count separately. Only attempts recorded by this version are counted. Reported tokens are not a verified bill. Missing usage, pending calls and unknown or zero catalog pricing stay explicit; `knownCost` is a subtotal when any cost is unknown. Timeout or cancelled requests may still incur unreported service usage.

Reopen and compaction preserve the ledger. Branch queries follow ancestry; session queries include abandoned branches. Forks inherit ancestor usage, so parent and fork totals must not be added blindly. On the earlier Pi 1.2.0 live checks, direct classifier usage fell outside `/session`; recheck host accounting after upgrades before combining totals. Main assistant outcome records are already represented in Pi session accounting and must not be added again.

### Thinking levels

Dispatch precedence is the virtual model setting, then the physical model setting, then the request thinking level. An eligible retry's `failed.thinkingLevel` takes precedence. Pi clamps levels for the physical model. Configure `settings.modelThinkingLevels` with keys such as `openai-codex/gpt-6-astra` or `jev/auto`.

## Privacy

By default, classifier input is only the projected visible text of the last native user entry. Converted custom messages, summaries and bash output do not replace that source. Images, thinking and tool data are excluded. `fixed` and initial `shadow` keep the `state.prompt` payload; `adaptive` uses `state.current`. If there is no source or the projected text is empty, no classifier call is made.

History sharing is off by default and has no effect on fixed or initial shadow classification:

```json
{ "strategy": "adaptive", "adaptive": { "contextMode": "recent-conversation" } }
```

This adds `state.recentTurns` and `state.historyPartial`. When enabled, adaptive classification and later shadow reassessments include this bounded history in addition to the current user text. A previous turn contains native user text and successful assistant text (`stop`/`toolUse`) in chronological order. Tools, thinking, images, system or custom messages, summaries and failed or aborted responses are excluded. Newest complete turns fit both history budgets; whole oldest turns are dropped. If the newest turn alone exceeds the budget, history is empty rather than skipping it to send older fragments. Current text has an independent `promptLimit`. Budgets exclude instructions and JSON overhead. No summary model runs.

Compaction and context edits are authoritative; deleted, replaced or cropped bodies are not recovered from raw entries. `historyPartial` indicates incomplete history, not classification confidence. User and assistant text may contain pasted secrets or file contents; filtering cannot guarantee secrecy. `classifier: null` disables all classifier transmission.

## Compatibility and troubleshooting

- **`jev/auto` is not listed:** make sure the package is installed, restart Pi, and remove any second copy loaded from a checkout.
- **A configured model is not in the catalog:** run `pi --list-models`, then fix `provider` or `models` in the configuration.
- **Classification fails or times out:** when no previous planning model can be reused, initial classification falls back to `standard`; later failures keep the current model. Set `classifier` to `null` to disable classification entirely. `missing-classifier` means the catalog holds no `classifier` model under that provider and id; `error` means the adapter request failed, which can be missing credentials, an unreachable endpoint, or a server-side fault. For `llama.cpp`, raise `classifier.timeoutMs` before assuming the router is broken.
- **Configuration changes do not apply:** restart Pi. Check the discovery order above and watch for unknown-key warnings.
- **Writes are not recognized:** hosts without nested write records can recognize only successful outer writes.

## Development and verification

```sh
# deterministic routing and lifecycle tests
npm test

# include the real public SessionManager cases
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

Without `PI_ROUTER_HOST_MODULE`, the host cases explicitly skip. [`plans/003-final-router.md`](plans/003-final-router.md) records 232 passing tests in 27 suites, including real `SessionManager` cases, and a strict `tsc --noEmit` check against the installed Pi and pi-ai declarations. Tests use deterministic classifier and catalog fixtures; they establish routing and lifecycle behavior, not classification accuracy, production latency, model-task quality or savings. Adapter cases use normalized results through registry mocks; live authentication and wire-protocol interoperability have not been verified.

`scripts/live-agent-smoke.ts` remains an explicitly billable, opt-in runner using the configured `codex-sub2api` sol/luna models and `typesafe/jev-latest`. It runs outside `npm test` in isolated temporary resources. Its core scenario requires the real classifier to satisfy the guarded handoff threshold; an untriggered path cannot count as validated. This release has not rerun the live scenarios. After reviewing the script and authorizing the calls:

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
# Other scenarios: core, cancel, retry
```

See [`RELEASING.md`](RELEASING.md) for maintainer release steps.

## License

MIT. See [`LICENSE`](LICENSE).

---

## 中文文档

**简体中文** · [English](#pi-jev-router)

`pi-jev-router` 是 [pi](https://pi.dev) 的扩展。它注册一个虚拟模型 `jev/auto`，把 agent 循环中的请求路由到 complex、standard、implementation 三个已配置的物理模型槽位。

直接请求（例如压缩、标题）使用 `models.direct`（如果配置），否则依次使用 implementation、standard。它不会根据模型名称或价格推断能力。

## 功能

一次会话很少每一步都需要同一个模型。`jev/auto` 让 pi 只暴露一个可选模型，把路由策略留在扩展里：

- **`fixed`**（默认）在初始化时对当前原生用户消息分类或复用可用的上一规划模型，在 complex 或 standard 上规划，并在第一次成功写入后把实现工作交接给 `models.implementation`。
- **`adaptive`** 在此基础上增加守卫式交接，并在分类器有把握时把后续原生用户输入升级到 complex。
- **`shadow`** 沿 fixed 的真实路由执行，只在建议升级时报告，不实际切换。

默认 `fixed` 策略的流程：

```text
初始化时的当前原生用户消息
       │
       ▼
     分类
    ├─ complex   → models.complex ──┐
    └─ 其他      → models.standard ─┤
                                    └─ 成功写入（edit/write）→ models.implementation
```

符合条件的上一规划模型会在分类前被复用。

## 安装

```sh
# 安装已发布版本
pi install npm:@caph42/pi-jev-router

# 或固定到某个版本
pi install npm:@caph42/pi-jev-router@1.0.1

# 或直接加载本地 checkout，不安装
pi -e ./extensions/jev-router.ts --model jev/auto
```

然后在 `/model` 中选择 **Auto (Jev)**，或直接启动：

```sh
pi --model jev/auto
```

用 `pi update --extensions` 升级。不要同时加载本地 checkout 和已安装的 npm 包：两者都会注册 `jev/auto`。安装包本身不会修改已有的 `jev-router.json`。

### 环境要求

- pi 需要支持虚拟模型、持久分支 ID 和 `buildSessionProjection()`。本版本在 Pi 1.3.0 上验证。
- complex、standard 以及显式配置的 `models.direct` 必须能在 `pi --list-models` 中解析。默认值都是 `openai-codex` 模型：`gpt-6-astra`、`gpt-6.1-sol` 和 `gpt-6-luna`。
- 分类器凭据可选。默认为 TypeSafe 的 `typesafe/jev-latest`；pi 的 `classifier` 类型模型都可以使用，包括 Cloudflare 的 Clef、`llama.cpp` router 和 OpenAI 的 Decisions API（见[分类器端点](#分类器端点)）。把 `classifier` 设为 `null` 或 `false` 可以关闭分类。
- Node 版本需与已安装的 Pi 兼容。本版本的 TypeScript 测试运行在 Node 24.15.0。

宿主不支持投影时，`fixed` 和 `shadow` 不会发送分类输入，也无法识别写入；初始化仍可选择 standard 或复用之前的规划模型。`adaptive` 依赖投影 API。

## 快速开始

默认的 `fixed` 策略可以直接配合 OpenAI Codex 登录使用。要启用 adaptive 路由并持久化诊断，创建 `~/.pi/agent/jev-router.json`：

```json
{
  "strategy": "adaptive",
  "diagnostics": { "record": true }
}
```

Codex 登录覆盖默认物理模型；默认分类器需要 TypeSafe 凭据。没有可用分类器时，adaptive 没有分类证据：它会复用可用的规划模型，或以 `standard` 起步，无法授权守卫式交接或分类器驱动的升级。

其他字段保持下面的默认值。修改配置后需要重启 Pi。

## 策略

| 策略 | 初始规划 | 成功写入之后 | 后续原生用户输入 |
| --- | --- | --- | --- |
| `fixed`（默认） | 初始化时对当前原生用户消息分类一次，或复用可用的上一规划模型 | 交接给 `models.implementation` | 保持当前模型 |
| `adaptive` | 同样的选择；默认守卫式交接 | 仅在输入足够简单且有界上下文满足条件时交接 | 概率达到 `threshold` 时升级到 complex，然后锁定 |
| `shadow` | 与 fixed 相同 | 与 fixed 相同 | 评估升级并报告，不实际应用 |

初始分类不可用时选择 `standard`；后续不可用时保持当前模型。初始选中的模型或 direct 目标不在模型目录中属于配置错误。交接或升级目标缺失时保持当前模型；持久状态中的模型缺失时修复为 `standard` 并锁定交接。`standard` 缺失同样是配置错误。

所有策略都使用有界分类、原生投影输入和零 SDK 重试；发生重试时会沿用失败的物理模型。取消会终止路由，不返回候选状态。直接请求绕过分类和状态，但仍响应取消。

## 配置

### 配置来源

| 来源 | 作用域 |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | 显式文件。设置后不再读取其他文件。 |
| `~/.pi/agent/jev-router.json` | 个人配置。`$PI_CODING_AGENT_DIR` 会移动 `~/.pi/agent` 目录。 |
| `<project>/.pi/jev-router.json` | 项目配置，合并并覆盖个人文件。 |

嵌套对象合并，数组整体替换。文件不存在是允许的，格式错误会失败。未知键会警告并被忽略。配置在 Pi 启动时读取，修改后请重启 Pi。[`jev-router.example.json`](jev-router.example.json) 包含所有默认值。

### 核心路由

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `strategy` | `fixed` | `fixed`、`adaptive` 或 `shadow` |
| `provider` | `openai-codex` | 物理模型槽位所在的 provider |
| `models.complex` | `gpt-6-astra` | 复杂工作 |
| `models.standard` | `gpt-6.1-sol` | 常规规划与初始化回退 |
| `models.implementation` | `gpt-6-luna` | 执行；`null` 或 `false` 关闭交接 |
| `models.direct` | `null` | 直接请求；依次跟随 `implementation`、`standard` |
| `classifier.provider` | `typesafe` | 分类器 provider；把 `classifier` 设为 `null` 或 `false` 可关闭分类 |
| `classifier.id` | `jev-latest` | 分类器模型 id |
| `classifier.temperature` | 未设置 | 归一化前对 label logits 做除法，取值大于 0、不超过 100；只有按 label 概率出答案的适配器读取它，其他适配器忽略 |
| `classifier.timeoutMs` | 未设置 | 单次分类器调用的本地期限，1–60000 的整数；设置后覆盖 `adaptive.decisionTimeoutMs` |
| `threshold` | `0.5` | 概率大于等于该值时选中 complex |
| `promptLimit` | `16000` | 当前文本预算，单位为 UTF-16 code unit |
| `adaptive.decisionTimeoutMs` | `3000` | 分类器本地总期限，1–60000 的整数；适用于**所有**策略 |

### 分类器端点

`classifier.provider` 与 `classifier.id` 指向 pi `classifier` 类型中的任意模型；路由本身不解析端点格式，由目录决定某个模型走哪个适配器。四种适配器及各自要求：

| API | 示例模型 | 凭据 | 说明 |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | 默认值。直连模型没有目录价格，`/jev-usage` 的成本始终显示为 unknown。 |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` 与 `CLOUDFLARE_ACCOUNT_ID` | Workers AI 上的 Jev 也走它。 |
| `llama-cpp-classify` | `llama.cpp` router 中的任意 chat 模型 | Pi 的 `/login llama.cpp` 连接，可选填服务端 API key | 依赖 llama.cpp 原生的 `/tokenize`、`/apply-template` 和 `/completion` 端点。state 渲染两次，可通过 `classifier.timeoutMs` 为分词、模板渲染和概率读取留出时间。原始 label 概率通常过度自信，`classifier.temperature` 大于 1 可使其变软。 |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | 通过 `/login` 的 ChatGPT 账号不提供该 key；要用 key 就先退出 `openai` 登录。 |

`openrouter`、`vercel-ai-gateway` 与 `opencode` 上的分类器代理 System One 格式，使用各自 provider 的凭据。目录中缺失的分类器返回 `missing-classifier`，适配器报错返回 `error`。初始化没有可复用的规划模型时回退到 `standard`；后续失败保留当前模型。两类失败都不会授权守卫式交接。更换分类器、模型或 `classifier.temperature` 会改变概率校准，应重新核对 `threshold`，不要假设旧值仍然适用。

### Adaptive 路由

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`，或显式启用旧版 `first-write` |
| `adaptive.handoffThreshold` | `0.2` | 守卫式交接允许的最大 complex 概率，范围 0–1 |
| `adaptive.maxHandoffContextTokens` | `50000` | 正安全整数；守卫式交接要求已知估算不超过此值 |
| `adaptive.handoffTools` | `edit`、`write` | 可触发 adaptive 交接的成功写入工具 |
| `adaptive.contextMode` | `last-user-only` | 或 opt-in 的 `recent-conversation`；供 adaptive 分类和 shadow 重新评估使用 |
| `adaptive.historyMaxTurns` | `4` | 历史完整轮数，1–8 的整数 |
| `adaptive.historyCharLimit` | `8000` | 历史文本预算，1–32000 的整数，单位为 UTF-16 code unit |

### 虚拟模型与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `virtual.provider` | `jev` | 虚拟模型所在的 provider |
| `virtual.id` | `auto` | 模型 id，默认选择为 `jev/auto` |
| `virtual.name` | `Auto (Jev)` | 在 `/model` 中显示的名称 |
| `virtual.thinkingLevels` | `low`、`medium`、`high`、`xhigh`、`max` | 提供的思考强度 |
| `virtual.contextWindow` | `272000` | 初始展示的上下文窗口；路由后采用物理模型的限制 |
| `virtual.maxTokens` | `128000` | 初始展示的最大输出；路由后采用物理模型的限制 |
| `diagnostics.record` | `false` | 持久化脱敏的决策与主请求结果记录 |
| `debug` | `false` | 在 stderr 输出结构化路由信息；也支持 `JEV_ROUTER_DEBUG=1` |

全局分类期限沿用原来的 `adaptive.decisionTimeoutMs` 字段名以保持兼容。3000 ms 默认值不代表最优延迟或成本结论。守卫字段只影响 adaptive。`fixed` 和 `shadow` 使用 `edit`/`write`，包括成功的嵌套记录。`adaptive.handoffTools` 为空会关闭 adaptive 交接。`bash`/`codemode` 不能被加入白名单，包装工具成功也不算写入证据；自定义工具名必须在成功时代表写入。新增的 `strategy`、`adaptive` 和 `diagnostics` 字段拒绝显式 `null` 和非法值，`classifier.temperature`、`classifier.timeoutMs` 亦然；省略某项分类器选项时沿用继承值。模型槽位和 `classifier` 原有的 `null`/`false` 约定保持不变。

## 路由流程

### 初始选择

初始化时，如果存在可用的上一规划模型（complex 或 standard，且位于配置的 provider），路由会直接复用；否则对当前原生用户消息分类一次。概率达到或超过 `threshold` 时选择 `models.complex`，否则选择 `models.standard`。分类不可用时使用 `standard`，后续分类失败则保持当前模型。

初始分类会定位最后一条原始角色为 `user` 的原生来源条目，并把其投影后的可见文本作为当前输入。转换后的自定义消息、摘要和 bash 输出不会替代该来源。原生用户条目也可能来自 SDK 或扩展，并不证明文本一定由人输入。请求级的上下文变换不会替代用于分类的持久投影。

### 交接与升级

守卫式 adaptive 交接需要同时满足：

1. 初始槽位为 `standard`，complex 概率有效、低于 `threshold`，且不超过 `adaptive.handoffThreshold`。复用上一模型不提供分类证据。
2. 当前原生投影文本非空、未截断且不含图片。实际分类输入仍与决策时一致；状态中只保存其 SHA-256 摘要。
3. 当前原生用户条目和阶段锚点之后发生了一次白名单内的成功写入。
4. 当前上下文 token 估算有限、非负，且不超过 `adaptive.maxHandoffContextTokens`。
5. implementation 模型仍然可用。

守卫策略下，初始 complex 会被锁定。分类被禁用或缺失、回答无效、报错和超时都不会授权守卫式交接。新的用户评估会让尚未使用的初始交接失效。每个新的原生条目 ID 最多评估一次；文本相同但 ID 不同算新请求。complex 槽位跳过后续评估。之后的升级进入锁定规划。在配置和目录不变时，一个分支最多有一次初始交接和一次升级。没有任务结束检测，也不会从 complex 自动退回 implementation 槽位。

要保留最初的 first-write 交接行为，显式设置：

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` 允许在初始 complex 或分类不可用后仍然交接，不受简单输入和上下文门槛限制。后续升级仍会锁定规划。

`nestedCalls` 中状态为 `ok` 的成功条目即使外层工具后来失败或记录不完整也算数。它证明写入已经完成，不证明整体任务完成。失败或未完成的嵌套调用、工具参数、口头声称“已写入”以及成功的包装工具都不算。原生分支边界会阻止旧写入触发当前交接。宿主没有嵌套记录时，只能识别成功的外层写入。

### 重试、取消与期限

重试不会分类，也不会交接。它会优先使用配置 provider 上、配置槽位或当前状态中可用的失败模型，并保留其思考强度。否则使用有效状态、可用的上一规划模型或 `standard`。重试会锁定剩余的交接机会；重复重试不会追加相同状态。Pi 在主请求派发前持久化返回的状态，因此后续模型失败不会撤销它。

所有策略都使用有界分类调用和零 SDK 重试。`adaptive.decisionTimeoutMs` 是本地总期限，适用于所有策略；设置 `classifier.timeoutMs` 后，只对分类器调用替换它。期限先到时，晚到的成功或失败都会被忽略。调用方取消或服务中止会终止路由，不返回候选状态。直接请求绕过分类和状态，但仍响应取消。

### 状态与迁移

Adaptive 状态使用 `schemaVersion: 1` 和 `policyVersion: "adaptive-v2"`。旧的 phase/model 状态和 adaptive-v1 状态迁移时会锁定交接。配置或 provider 变化、锚点丢失会关闭旧的交接资格。未知 schema 会失败并给出恢复建议。`fixed` 可以消费 adaptive 的 phase/model 状态；显式切换回 `fixed` 会恢复 fixed 的交接策略。Fixed 状态也会记录 provider、交接锁和阶段锚点。状态跟随恢复、压缩和分支祖先；新会话会重新开始策略。

## Shadow 模式

`shadow` 沿 fixed 的物理路由和初始纯提示分类执行。在 complex 槽位以下的后续原生用户请求中，它使用 adaptive 的输入范围，建议保持当前模型或升级。即使 `debug` 关闭，也会在 stderr 输出 `proposedModel`、`available` 和 `applied=false`。它不模拟另一条 adaptive 分支，也不证明质量或成本收益。最后评估的条目 ID 会持久化，避免重开后重复调用。重试和 continuation 不执行 shadow 分类。

## 诊断与用量

设置 `diagnostics.record: true` 后，`pi-jev-router.decision` 条目会包含路由原因、物理源模型与目标模型、请求的思考强度、`classifierStatus`、分类器适配器（`classifierApi`）、概率、耗时、脱敏 usage 和上下文估算。随机 `decisionId` 会把最终的主助手响应关联到 `pi-jev-router.outcome` 条目，其中包含实际思考强度、停止原因、失败类别、上报的 usage 和路由后的耗时。缺失的 outcome 会保持缺失；这不是 HTTP 日志，也不是首 token 延迟测量。直接调用不会创建 decision/outcome 记录。记录 outcome 前会核对会话和分支祖先，待关联记录会在会话和 agent 边界清理。超过期限或会话、分支、输入已失效后到达的分类结果不会被应用。

诊断和分类记录不包含提示词、代码、工具参数、响应正文、凭据和原始错误。持久化失败只会输出 `diagnostics-unavailable`，不改变路由；写入失败可能导致 usage 不完整或处于 pending。诊断不进入模型上下文，也不是额外的计费来源。不要把 outcome usage 与 Pi 自己的会话总计相加。

### `/jev-usage`

| 命令 | 范围 |
| --- | --- |
| `/jev-usage` | 当前分支 |
| `/jev-usage --session` | 当前会话文件中的所有条目，包括被放弃的分支 |
| `/jev-usage --json` | 结构化输出 |

查询不会调用模型，也不会改变状态。公开导出 `summarizeClassifierUsage(manager, virtual?, scope?)` 提供相同数据；其中的 `apis` 字段列出已记录尝试涉及的分类器适配器。

每次实际分类尝试都有随机 call ID、pending 快照和 terminal 快照。快照只计一次；取消后的真实重试单独计入。只统计本版本记录的尝试。上报的 token 不是经过验证的账单。缺失 usage、pending 调用以及未知或为零的目录价格会明确标出；存在未知成本时，`knownCost` 只是小计。超时或取消的请求仍可能产生未上报的服务用量。

重开和压缩会保留分类账。分支查询沿祖先关系；会话查询包含被放弃的分支。Fork 会继承祖先 usage，不能把父分支和 fork 的总计盲目相加。在更早的 Pi 1.2.0 在线检查中，直接分类器用量不在 `/session` 内；升级宿主后要重新核对计费口径，再合并总计。主助手 outcome 记录已经包含在 Pi 的会话计费中，不能重复相加。

### 思考强度

派发优先级依次为虚拟模型设置、物理模型设置、请求的思考强度。符合条件的重试中，`failed.thinkingLevel` 优先。Pi 会按物理模型钳制强度。通过 `settings.modelThinkingLevels` 配置 `openai-codex/gpt-6-astra` 或 `jev/auto` 等键。

## 隐私

默认情况下，分类器输入只有最后一条原生用户条目的投影可见文本。转换后的自定义消息、摘要和 bash 输出不会替代该来源。图片、思考和工具数据会被排除。`fixed` 和初始 `shadow` 保留 `state.prompt` 负载；`adaptive` 使用 `state.current`。没有来源或投影文本为空时不会调用分类器。

历史共享默认关闭，对 fixed 和初始 shadow 分类没有影响：

```json
{ "strategy": "adaptive", "adaptive": { "contextMode": "recent-conversation" } }
```

这会增加 `state.recentTurns` 和 `state.historyPartial`。启用后，adaptive 分类和 shadow 的后续重新评估会在当前用户文本之外包含这段有界历史。上一轮包含原生用户文本和成功的助手文本（`stop`/`toolUse`），按时间顺序排列。工具、思考、图片、system 或 custom 消息、摘要以及失败或中止的响应都会被排除。最新的完整轮次需要同时满足两个历史预算；最旧的整轮会被丢弃。如果最新一轮本身就超出预算，历史为空，而不会跳过它去发送更早的片段。当前文本有独立的 `promptLimit`。预算不包含指令和 JSON 开销，也不会调用摘要模型。

压缩和上下文编辑是权威来源；被删除、替换或裁剪的正文不会从原始条目恢复。`historyPartial` 表示历史不完整，不代表分类置信度。用户和助手文本可能包含粘贴的密钥或文件内容，过滤无法保证保密。`classifier: null` 会关闭所有分类器传输。

## 兼容性与故障排查

- **列表中没有 `jev/auto`：** 确认包已安装，重启 Pi，并移除从 checkout 加载的第二份副本。
- **配置的模型不在目录中：** 运行 `pi --list-models`，然后在配置中修正 `provider` 或 `models`。
- **分类失败或超时：** 初始化没有可复用的规划模型时回退到 `standard`；后续失败保持当前模型。把 `classifier` 设为 `null` 可以完全关闭分类。`missing-classifier` 表示目录中没有该 provider/id 的 `classifier` 模型；`error` 表示适配器请求失败，可能来自缺失凭据、端点不可达或服务端故障。使用 `llama.cpp` 时先调高 `classifier.timeoutMs`，再判断是路由故障。
- **配置修改不生效：** 重启 Pi。检查上面的配置来源读取顺序，并留意未知键警告。
- **写入没有被识别：** 没有嵌套写入记录的宿主只能识别成功的外层写入。

## 开发与验证

```sh
# 确定性的路由与生命周期测试
npm test

# 包含真实公共 SessionManager 用例
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

未设置 `PI_ROUTER_HOST_MODULE` 时，宿主用例会明确跳过。[`plans/003-final-router.md`](plans/003-final-router.md) 记录了 27 个套件、232 项测试通过（包含真实 `SessionManager` 用例），以及针对本机 Pi 和 pi-ai 声明的严格 `tsc --noEmit` 检查。测试使用确定性的分类器和目录 fixture，验证路由与生命周期行为，不证明分类准确率、生产延迟、模型任务质量或节省费用。适配器用例通过注册表 mock 返回归一化结果；尚未验证真实认证和 HTTP 协议互通。

`scripts/live-agent-smoke.ts` 仍是需要显式开启并会产生费用的 runner，使用已配置的 `codex-sub2api` sol/luna 模型和 `typesafe/jev-latest`，在隔离的临时资源中运行，不属于 `npm test`。它的 core 场景要求真实分类器满足守卫式交接阈值；未触发的路径不能算已验证。本版本没有重跑 live 场景。审阅脚本并授权调用后：

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
# 其他场景：core、cancel、retry
```

维护者的发布步骤见 [`RELEASING.md`](RELEASING.md)。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。

[返回顶部](#pi-jev-router)
