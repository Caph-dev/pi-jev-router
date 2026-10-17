# pi-jev-router

A virtual model for [pi](https://pi.dev) with fixed, adaptive and shadow routing. Select
`jev/auto`; the router dispatches to configured complex, standard and implementation models
on one provider. It does not infer model capability from names or prices.

This worktree builds on feat/adaptive-routing and incorporates the verified routing protections
from the main comparison. See [final validation](plans/003-final-router.md). Earlier live reports
under plans/ describe the earlier implementation, not this worktree's online performance.

## Strategies

| Strategy | Initial planning | Successful write | Later native user input |
| --- | --- | --- | --- |
| `fixed` (default) | Classify once, or reuse available previous planning model | Hand off to implementation | Keep current model |
| `adaptive` | Same selection; guarded handoff by default | Hand off only with simple-input evidence and bounded context | Upgrade to complex when probability reaches threshold; then lock |
| `shadow` | Same as fixed | Same as fixed | Assess an upgrade and report it without applying it |

Initial classification unavailability selects standard. Later unavailability keeps the current
model. A selected initial model or direct target missing from the catalog is a configuration error.
A missing handoff/upgrade target keeps the current model; a missing persisted model is repaired to
standard and saved with handoff locked. Missing standard also produces a configuration error.

All strategies use bounded classification, zero SDK retries, native projected input and sticky
physical-model retries. Cancellation aborts routing without returning candidate state. Direct
requests bypass classification and state, but respect cancellation.

## Requirements and local use

- Pi with virtual models, persistent branch IDs and `buildSessionProjection()`. Verified against
  Pi 1.3.0. Adaptive requires these APIs. Without projection support fixed/shadow send no classifier
  input and cannot recognize writes; initialization can still select standard or reuse planning.
- Node compatible with the installed Pi; this checkout's native TypeScript tests ran on Node 24.15.0.
- Configured physical models present in `pi --list-models`. Defaults are openai-codex:
  gpt-6-astra / gpt-6.1-sol / gpt-6-luna.
- Optional TypeSafe credentials for Jev. `classifier: null` (or false) disables classification.

~~~sh
# Load this checkout once. A published package does not contain these uncommitted changes.
pi -e ./extensions/jev-router.ts --model jev/auto
# Or install the local checkout:
pi install /absolute/path/to/pi-jev-router-final
~~~

Choose Auto (Jev) in /model, or configure defaultProvider/defaultModel. Avoid loading another
installed copy of the router at the same time. Package installation and personal configuration
are separate from creating this worktree.

## Configuration

`JEV_ROUTER_CONFIG` selects one exclusive file. Otherwise personal
`~/.pi/agent/jev-router.json` is merged with project `<cwd>/.pi/jev-router.json`.
`PI_CODING_AGENT_DIR` relocates the personal directory. Nested fields merge; arrays replace.
Missing files are allowed; malformed files fail. Unknown keys warn and are ignored. Restart Pi
after changes. [jev-router.example.json](jev-router.example.json) contains every default.

For guarded adaptive routing with optional durable diagnostics:

~~~json
{
  "strategy": "adaptive",
  "diagnostics": { "record": true }
}
~~~

| Field | Default | Meaning |
| --- | --- | --- |
| strategy | fixed | fixed, adaptive or shadow |
| provider | openai-codex | Provider containing the physical slots |
| models.complex | gpt-6-astra | Demanding work |
| models.standard | gpt-6.1-sol | Ordinary planning and initialization fallback |
| models.implementation | gpt-6-luna | Execution; null/false disables handoff |
| models.direct | null | Direct requests; follows implementation, then standard |
| classifier | typesafe / jev-latest | Provider and id; null/false disables it |
| threshold | 0.5 | Inclusive probability threshold for complex selection |
| promptLimit | 16000 | Current text budget in UTF-16 code units |
| adaptive.handoffPolicy | guarded | guarded or explicit legacy first-write |
| adaptive.handoffThreshold | 0.2 | Maximum complex probability for guarded handoff, range 0–1 |
| adaptive.maxHandoffContextTokens | 50000 | Positive safe integer; guarded handoff requires a known estimate no larger than this |
| adaptive.handoffTools | edit, write | Successful write tools eligible for adaptive handoff |
| adaptive.decisionTimeoutMs | 3000 | Local total classifier deadline, integer 1–60000; applies to ALL strategies |
| adaptive.contextMode | last-user-only | Or opt-in recent-conversation; used by adaptive and shadow reassessments |
| adaptive.historyMaxTurns | 4 | Prior complete turns, integer 1–8 |
| adaptive.historyCharLimit | 8000 | History text budget, integer 1–32000 UTF-16 code units |
| diagnostics.record | false | Persist sanitized decision and main-request outcome entries |
| debug | false | Structured routing metadata on stderr; also JEV_ROUTER_DEBUG=1 |
| virtual.provider / id / name | jev / auto / Auto (Jev) | Selectable virtual model |
| virtual.thinkingLevels | low, medium, high, xhigh, max | Offered thinking levels |
| virtual.contextWindow / maxTokens | 272000 / 128000 | Initial advertised limits; routes adopt physical limits |

The timeout field keeps its feat configuration name for compatibility. No optimal latency or
cost claim is attached to the 3000ms default. Guard fields affect adaptive only. Fixed and shadow
use edit/write, including successful nested records. Empty adaptive.handoffTools disables adaptive
handoff. bash/codemode cannot be whitelisted; wrapper success is not write evidence. Custom tool
names must represent a write when successful. New strategy/adaptive/diagnostics fields reject
explicit null and invalid values; model-slot and classifier null/false conventions remain intact.

## Handoff and upgrade lifecycle

Guarded adaptive handoff requires all of the following:

- The initial slot was standard, with a valid complex probability below threshold and at most
  handoffThreshold. Reusing a previous model provides no classification evidence.
- Current native projected text is nonempty, untruncated and has no image. The effective classifier
  input still matches the input used for the decision; only its SHA-256 digest is stored in state.
- A successful whitelisted write follows both the current native user entry and stage anchor.
- The current context-token estimate is finite, nonnegative and within the configured limit.
- The implementation model remains available.

Initial complex selection is locked under guarded policy. Disabled/missing classification,
invalid answers, errors and timeouts never authorize guarded handoff. A new user assessment closes
unused initial handoff. Each new native entry ID is assessed at most once; identical text with a
new ID is a new request. Complex slots skip further assessment. A later upgrade enters locked
planning. Under unchanged configuration/catalog a branch has at most one initial handoff and one
upgrade. There is no task-end detection or automatic return from complex to a cheaper slot.

To retain feat's original initial handoff, explicitly set:

~~~json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
~~~

This permits handoff even after initial complex selection or classification unavailability,
without the simple-input/context gates. Subsequent upgrades still lock planning.

Successful nestedCalls entries with status ok count even if the outer tool later failed or its
record is incomplete. They prove a completed write, not completion of the overall task. Failed or
unfinished nested calls, tool arguments, prose saying “written”, and successful wrappers do not
count. Native branch boundaries prevent old writes from triggering the current handoff. Hosts
without nested records can recognize only successful outer writes.

Retries never classify or hand off. They prefer an available failed model on the configured
provider and in the configured slots/current state, preserving its thinking level. Otherwise
valid state, available previous planning or standard is used. Retry locks remaining handoff;
repeated retries do not append identical state. Pi persists returned state before main dispatch,
so a later model failure does not undo that state.

Adaptive state uses schemaVersion 1 / policyVersion adaptive-v2. Legacy phase/model and adaptive-v1
states migrate with handoff locked. Configuration/provider changes or lost anchors close old
handoff eligibility. Unknown schemas fail with recovery advice. Fixed can consume adaptive
phase/model state; explicitly switching to fixed restores fixed's handoff policy. Fixed state
now also records provider, handoff lock and stage anchor. State follows resume, compaction and
branch ancestry; a new session starts the policy anew.

## Shadow and diagnostics

Shadow follows fixed's physical routing and initial prompt-only classification. On later native
user requests below the complex slot, it uses the adaptive input scope to suggest keeping the
current model or upgrading. It logs proposedModel, available and applied=false on stderr even
when debug is off. It does not simulate a separate adaptive branch or prove quality/cost gains.
The last assessed entry ID is persisted to avoid duplicate calls after reopen. Retry and
continuation do not perform shadow classification.

With diagnostics.record=true, pi-jev-router.decision entries include routing reasons, physical
from/to models, requested thinking level, classifier status/probability/duration, safe usage and
context estimate. A random decisionId links a finalized main assistant response to its
pi-jev-router.outcome entry, including actual thinking level, stop reason, failure category,
reported usage and elapsed time after routing. Missing outcomes remain missing; this is not an
HTTP log or first-token latency measurement. Direct calls do not create decision/outcome records.
Session/branch ancestry is checked before recording outcomes, and pending associations are cleared
at session and agent boundaries. Classifier results arriving after a deadline or invalidated
session/branch/input are not applied.

Diagnostics and classification records exclude prompts, code, tool arguments, response bodies,
credentials and raw errors. Persistence errors emit only diagnostics-unavailable and do not alter
routing; a failed write can leave usage incomplete or pending. Diagnostics are excluded from model
context. They are not an additional billable usage source; do not sum duplicate outcome usage with
Pi's own session totals.

## Classifier input and privacy

Every strategy locates the last native source entry whose original role is user and sends only
its projected visible text. Converted custom messages, summaries and bash output do not replace
that source. A native user may originate from an SDK/extension; it does not establish human authorship.
Request-local context transforms do not replace the persistent projection used for classification.
Fixed and initial shadow keep the state.prompt payload; adaptive uses state.current. No source or
empty projected text causes no classifier call. Images, thinking and tool data are excluded.

To share bounded history:

~~~json
{ "strategy": "adaptive", "adaptive": { "contextMode": "recent-conversation" } }
~~~

This adds state.recentTurns and state.historyPartial. A previous turn contains native user text
and successful assistant text (stop/toolUse), in chronological order. Tools, thinking, images,
system/custom messages, summaries and failed/aborted responses are excluded. Newest complete
turns fit both history budgets; whole oldest turns are dropped. If the newest turn alone exceeds
the budget, history is empty rather than skipping it to send older fragments. Current text has an
independent promptLimit. Budgets exclude instructions and JSON overhead. No summary model runs.

Compaction and context edits are authoritative; deleted/replaced/cropped bodies are not recovered
from raw entries. historyPartial indicates incomplete history, not classification confidence.
User/assistant text may contain pasted secrets or file contents; filtering cannot guarantee secrecy.
classifier=null disables all classifier transmission. History sharing remains off by default and
has no effect on fixed or initial shadow classification.

## Thinking and classifier usage

Dispatch precedence is virtual model setting, physical model setting, then request thinking level.
An eligible retry's failed.thinkingLevel takes precedence. Pi clamps levels for the physical model.
Configure settings.modelThinkingLevels with keys such as openai-codex/gpt-6-astra or jev/auto.

/jev-usage queries the current branch, /jev-usage --session includes all entries in the current
session file, and --json emits structured output. Queries call no model and do not change state.
The public summarizeClassifierUsage(manager, virtual?, scope?) export provides the same data.

Each actual classification attempt has a random call ID, a pending snapshot and a terminal
snapshot. Snapshots count once; real reattempts after cancellation count separately. Only attempts
recorded by this version are counted. Reported tokens are not a verified bill. Missing usage,
pending calls and unknown/zero catalog pricing stay explicit; knownCost is a subtotal when any
cost is unknown. Timeout or cancelled requests may still incur unreported service usage.

Reopen and compaction preserve the ledger. Branch queries follow ancestry; session queries include
abandoned branches. Forks inherit ancestor usage, so parent/fork totals must not be blindly added.
On the earlier Pi 1.2.0 live checks, direct classifier usage was outside /session. Recheck host
accounting after upgrades before combining totals. Main assistant outcome records are already
represented in Pi session accounting and must not be added again.

## 中文速览

默认 fixed 保留两阶段交接；adaptive 默认采用 guarded，仅在完整无图输入被判为足够简单、
上下文已知且不超过 50000 tokens、当前阶段已有成功写入时交接。初始 complex 和后续升级均锁定。
显式 handoffPolicy=first-write 可继续使用 feat 的原始初始交接策略。

三种策略统一使用原生用户投影、分类期限、零 SDK 重试、取消传播和重试模型/强度保持。
Codemode 内成功 edit/write 仍可作为写入证据。历史默认关闭，/jev-usage 分类账保留。
shadow 沿 fixed 实际执行，只记录后续升级建议；diagnostics.record 默认关闭，开启后关联决策与主请求结果。
迁移旧 adaptive 状态时关闭旧交接资格；模型目录缺失后修复状态，目标模型缺失时保留当前模型。

## Verification

~~~sh
npm test
# Include the real public SessionManager cases; an invalid configured path fails.
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
~~~

Without PI_ROUTER_HOST_MODULE, the host cases explicitly skip. See
[plans/003-final-router.md](plans/003-final-router.md) for current counts and type-check evidence.
Tests use deterministic classifier/catalog fixtures. They establish routing and lifecycle behavior,
not classification accuracy, production latency, model-task quality or savings.

scripts/live-agent-smoke.ts remains an explicitly billable, opt-in runner using configured
codex-sub2api sol/luna and typesafe/jev-latest. It runs outside npm test in isolated temporary
resources. Its core scenario requires the real classifier to satisfy the guarded handoff threshold;
an untriggered path cannot count as validated. This worktree has not rerun the live scenarios.
After reviewing the script and authorizing calls, use:

~~~sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
# Other scenarios: core, cancel, retry
~~~

[RELEASING.md](RELEASING.md) documents maintainer release steps. License: MIT.
