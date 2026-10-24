# pi-jev-router

[简体中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/@caph42/pi-jev-router)](https://www.npmjs.com/package/@caph42/pi-jev-router)
[![license](https://img.shields.io/npm/l/@caph42/pi-jev-router)](LICENSE)

`pi-jev-router` is a [pi](https://pi.dev) extension. It registers one virtual model, `jev/auto`, and routes each agent-loop request to a configured model slot.

Agent-loop requests use `models.complex`, `models.standard`, or `models.implementation`. A direct request, such as compaction or a title, uses `models.direct` when that field is set. Otherwise the direct request uses `models.implementation`, then `models.standard`. The router reads the configuration and the classifier result. The model name and the price are not inputs.

## Installation

Install the published package:

```sh
pi install npm:@caph42/pi-jev-router
```

Pin one release:

```sh
pi install npm:@caph42/pi-jev-router@1.0.2
```

Load a checkout without installing it:

```sh
pi -e ./extensions/jev-router.ts --model jev/auto
```

Select **Auto (Jev)** in `/model`, or start Pi with `pi --model jev/auto`.

Upgrade with `pi update --extensions`. Load either the checkout or the npm package. Loading both registers `jev/auto` twice. Installing the package leaves an existing `jev-router.json` unchanged.

### Requirements

- Pi exposes virtual models, persistent branch ids, and `buildSessionProjection()`. This package was checked against Pi 1.3.0.
- `models.complex`, `models.standard`, and a configured `models.direct` resolve in `pi --list-models`. The defaults are `openai-codex` models: `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6-luna`.
- The classifier is optional. The default model is `typesafe/jev-latest`. Any model of Pi's `classifier` type works. Adapters are listed under [Classifier endpoints](#classifier-endpoints). Set `classifier` to `null` or `false` to turn classification off.
- Use a Node version the installed Pi supports. This package allows Node 20 or newer. The TypeScript tests for this release ran on Node 24.15.0.

Without `buildSessionProjection()`, `fixed` and `shadow` send no classifier input and do not detect writes. Initialization can still select `models.standard` or reuse a previous planning model. `adaptive` calls the projection APIs and fails without them.

## Strategies

A planning model is `models.complex` or `models.standard` on the configured provider. The router reuses an available previous planning model before classification.

`fixed` is the default. Its path is:

```text
current native user entry at initialization
       │
       ▼
   classify
    ├─ complex   → models.complex ──┐
    └─ otherwise → models.standard ─┤
                                    └─ successful edit or write → models.implementation
```

| Strategy | Initial planning | After a successful write | Later native user entry |
| --- | --- | --- | --- |
| `fixed` | Classify once, or reuse an available previous planning model | Hand off to `models.implementation` | Keep the current model |
| `adaptive` | Same choice. Guarded handoff is the default | Hand off when every guarded condition holds | Upgrade to `models.complex` at `threshold`, then lock planning |
| `shadow` | Same route as `fixed` | Same route as `fixed` | Record the upgrade and keep the `fixed` model |

When the first classification is unavailable, the router selects `models.standard`. When a later classification is unavailable, the router keeps the current model.

A missing initial model is a configuration error. A missing `models.direct` target is a configuration error. A missing `models.standard` model is a configuration error. A missing handoff target or upgrade target keeps the current model. A model saved in state that is no longer in the catalog is replaced with `models.standard`, and the saved state locks handoff.

Each strategy sends projected native text and calls the classifier with `maxRetries` set to 0. The call stops at the local deadline. A retry stays on the failed model. Cancellation aborts routing and returns no candidate state. A direct request skips classification and saved state. Cancellation still aborts that request.

## Configuration

The default `fixed` strategy needs no config file when an OpenAI Codex login can see the default models. The following file selects `adaptive` and records diagnostics:

```json
{
  "strategy": "adaptive",
  "diagnostics": { "record": true }
}
```

The Codex login covers the default models. The default classifier needs a TypeSafe credential. With no usable classifier, `adaptive` has no probability for the current input. `adaptive` reuses an available planning model, or `adaptive` starts on `models.standard`. Guarded handoff stays off. A classifier upgrade stays off.

Pi reads configuration at startup. Restart Pi after an edit. [`jev-router.example.json`](jev-router.example.json) lists every built-in default.

### Configuration files

Pi reads the files in this table.

| Source | Scope |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | That file alone. Pi reads no other config file. |
| `~/.pi/agent/jev-router.json` | Personal file. When `PI_CODING_AGENT_DIR` is set, the personal file is `$PI_CODING_AGENT_DIR/jev-router.json`. |
| `<project>/.pi/jev-router.json` | Project file, merged over the personal file. |

Nested objects merge. An array in a later file replaces that array. A missing file is valid. A malformed file fails startup. An unknown key prints a warning and is ignored.

### Route fields

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `fixed` | `fixed`, `adaptive`, or `shadow` |
| `provider` | `openai-codex` | Provider that holds the slot models |
| `models.complex` | `gpt-6-astra` | Planning model for work the classifier marks complex |
| `models.standard` | `gpt-6.1-sol` | Planning model otherwise, and the model used when the first classification is unavailable |
| `models.implementation` | `gpt-6-luna` | Model after handoff. `null` or `false` turns handoff off |
| `models.direct` | `null` | Model for direct requests. `null` uses `models.implementation`, then `models.standard` |
| `classifier.provider` | `typesafe` | Classifier provider. `null` or `false` on `classifier` turns classification off |
| `classifier.id` | `jev-latest` | Classifier model id |
| `classifier.temperature` | omitted | Divisor for label logits before normalization. Greater than 0 and at most 100 |
| `classifier.timeoutMs` | omitted | Deadline for one classifier call, an integer from 1 to 60000. Replaces `adaptive.decisionTimeoutMs` for that call |
| `threshold` | `0.5` | Probability at or above this value selects `models.complex`. From 0 to 1 |
| `promptLimit` | `16000` | Current-text limit in UTF-16 code units. A number from 1 to 1000000 |
| `adaptive.decisionTimeoutMs` | `3000` | Local deadline for classification, an integer from 1 to 60000. Applies to every strategy |

`classifier.temperature` is read by adapters that rank label probabilities. Other adapters ignore it. Omitting `classifier.temperature` or `classifier.timeoutMs` keeps the inherited value.

The deadline field keeps the name `adaptive.decisionTimeoutMs` so older files still parse. 3000 milliseconds is the compatibility default.

### Classifier endpoints

`classifier.provider` and `classifier.id` name a model whose Pi type is `classifier`. The router does not parse endpoint URLs. The catalog entry selects the adapter.

| API | Example model | Credentials | Notes |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | Default. The direct model has no catalog price, so `/jev-usage` reports its cost as unknown. |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | Also used for Jev models on Workers AI. |
| `llama-cpp-classify` | A chat model on a `llama.cpp` router | Pi's `/login llama.cpp` connection. A server API key is optional. | Needs llama.cpp `/tokenize`, `/apply-template`, and `/completion`. |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | A ChatGPT login from `/login` does not provide this key. Log out of the `openai` provider before using the key. |

`llama-cpp-classify` renders the classifier state twice. Set `classifier.timeoutMs` long enough for tokenization, templating, and the probability read. Raw label probabilities from llama.cpp are often overconfident. A `classifier.temperature` greater than 1 divides the logits before normalization. That division makes a probability near 0 or 1 less extreme.

Models on `openrouter`, `vercel-ai-gateway`, and `opencode` proxy the System One format and use that provider's credentials.

A classifier missing from the catalog yields `missing-classifier`. An adapter failure yields `error`. With no previous planning model to reuse, initialization selects `models.standard`. A later failure keeps the current model. Neither result allows guarded handoff.

Set `threshold` again after a change to the classifier, the model, or `classifier.temperature`. Each of those changes the probability scale.

### Adaptive fields

| Field | Default | Meaning |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`, or `first-write` for the older handoff rule |
| `adaptive.handoffThreshold` | `0.2` | Highest complex probability that still allows guarded handoff. From 0 to 1 |
| `adaptive.maxHandoffContextTokens` | `50000` | Largest context estimate that still allows guarded handoff. An integer from 1 to the maximum safe integer |
| `adaptive.handoffTools` | `edit`, `write` | Tool names whose success can hand off under `adaptive` |
| `adaptive.contextMode` | `last-user-only` | `recent-conversation` adds earlier turns inside the history limits. Adaptive classification and later shadow checks use this mode |
| `adaptive.historyMaxTurns` | `4` | Earlier complete turns to keep. An integer from 1 to 8 |
| `adaptive.historyCharLimit` | `8000` | History text limit in UTF-16 code units. An integer from 1 to 32000 |

Handoff fields apply to `adaptive`. `fixed` and `shadow` treat a successful `edit` or `write` as a write, including a successful nested call.

An empty `adaptive.handoffTools` array turns adaptive handoff off. `bash` and `codemode` are rejected. A successful wrapper tool is not a write. A custom name is valid when success from that tool is a write.

`strategy`, `adaptive`, and `diagnostics` reject `null` and other invalid values. `classifier.temperature` and `classifier.timeoutMs` reject `null` as well. `models.implementation`, `models.direct`, and `classifier` still accept `null` or `false`.

### Virtual model and diagnostics

| Field | Default | Meaning |
| --- | --- | --- |
| `virtual.provider` | `jev` | Provider shown for the virtual model |
| `virtual.id` | `auto` | Model id. The default selection is `jev/auto` |
| `virtual.name` | `Auto (Jev)` | Name shown in `/model` |
| `virtual.thinkingLevels` | `low`, `medium`, `high`, `xhigh`, `max` | Thinking levels offered for the virtual model |
| `virtual.contextWindow` | `272000` | Context window shown before the first routed response |
| `virtual.maxTokens` | `128000` | Max output shown before the first routed response |
| `diagnostics.record` | `false` | Store sanitized decision entries and main-request outcome entries |
| `debug` | `false` | Write routing metadata to stderr. `JEV_ROUTER_DEBUG=1` turns the same log on |

After the first route, the virtual model shows the routed model's context window and max output.

## Routing

### Initial selection

On initialization, the router reuses an available previous planning model. With no planning model available, the router classifies the current native user entry once.

The native user entry is the last projection source whose original role is `user`. The classifier reads that entry's projected visible text. A converted custom message, a summary, or bash output does not replace that source. The entry can come from the SDK or another extension. A `user` role does not mean a person typed the text. A transform that exists for one request does not replace the stored projection.

A probability at or above `threshold` selects `models.complex`. A lower probability selects `models.standard`. When classification is unavailable, initialization selects `models.standard`. A later failure keeps the current model.

### Handoff and upgrade

Guarded adaptive handoff requires all of the following:

- The initial slot was `models.standard`. The complex probability was valid, below `threshold`, and at most `adaptive.handoffThreshold`. A reused planning model has no stored probability. Guarded handoff requires that probability.
- The current native projected text is non-empty, within `promptLimit`, and has no image. The classifier input still matches the input used for the decision. State stores the SHA-256 digest of that input.
- A successful call from `adaptive.handoffTools` appears after both the current native user entry and `stageStartEntryId`.
- The context-token estimate is finite, zero or greater, and at most `adaptive.maxHandoffContextTokens`.
- `models.implementation` is still in the catalog.

An initial complex selection locks handoff under `guarded`. Disabled classification, a missing classifier, an invalid answer, an error, or a timeout does not allow guarded handoff. A new native user entry locks an initial handoff that has not run.

Each new native entry id is assessed at most once. The same text with a new id is a new request. A complex slot skips later assessment. An upgrade locks planning on `models.complex`. With the same configuration and catalog, a branch gets at most one initial handoff and one upgrade. The router has no task-end check. A complex slot stays on `models.complex` for the rest of that route.

To keep the older first-write rule, set the policy in config:

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` allows handoff after an initial complex selection, and when classification was unavailable. It skips the text checks and the context-token limit. A later upgrade still locks planning.

A nested call with status `ok` counts when the outer tool later fails or its record is incomplete. The call shows that a write finished. It does not show that the whole task finished. A failed or unfinished nested call does not count. Tool arguments do not count. Prose that says the file was written does not count. A successful wrapper tool does not count.

The check uses entry ids on the current branch. A write before `stageStartEntryId`, or before the current native user entry, does not start this handoff. Without nested tool records, Pi recognizes a successful outer write and does not recognize a nested write.

### Retries, cancellation, and deadlines

A retry does not classify and does not hand off. The retry keeps the failed model when that model is still available on the configured provider. The failed model's id has to match a configured model id, or the id already stored in state. The retry keeps the failed model's thinking level. When those checks fail, the retry uses valid state, an available previous planning model, or `models.standard`.

A retry locks any handoff that is still open. Repeating a retry does not append a second copy of the same state. Pi stores the returned state before it sends the main request. A later model failure does not undo that stored state.

`adaptive.decisionTimeoutMs` is the local deadline. The deadline applies to every strategy. When `classifier.timeoutMs` is set, the classifier call uses that value. If the deadline is reached first, a later success or failure is ignored. Caller cancellation or a service abort stops routing and returns no candidate state. A direct request skips classification and saved state. Cancellation still stops that request.

### State and migration

Adaptive state uses `schemaVersion` 1 and `policyVersion` `"adaptive-v2"`. Older phase and model state migrates with handoff locked. `adaptive-v1` state migrates the same way.

A configuration change, a provider change, or a lost `stageStartEntryId` ends the previous handoff. Invalid adaptive state fails with `invalid adaptive state; start a new session or switch strategy to fixed`.

`fixed` can read adaptive phase and model state. Setting `strategy` to `fixed` restores fixed handoff. Fixed state records the provider, the handoff lock, and `stageStartEntryId`. State follows resume, compaction, and branch ancestry. A new session starts with no saved routing state.

## Shadow mode

`shadow` uses the `fixed` route and classifies the initial prompt. On a later native user entry, while the slot is not `models.complex`, `shadow` reads the adaptive input. `shadow` then keeps the current model or names an upgrade.

stderr includes `proposedModel`, `available`, and `applied` set to false. The line is printed when `debug` is off. When `debug` is on, the debug log includes the same decision. `shadow` keeps the `fixed` model. The logged model is the upgrade `shadow` would have selected. The fields include no quality score and no cost delta.

The last assessed entry id is stored, so a reopen does not classify that entry again. A retry does not run shadow classification. A continuation does not run shadow classification.

## Diagnostics

Set `diagnostics.record` to true to store entries.

A `pi-jev-router.decision` entry includes `decisionReason`, the source model, the target model, and the requested thinking level. It also includes `classifierStatus`, `classifierApi`, the probability, the duration, safe usage, and the context estimate.

A random `decisionId` links that entry to the `pi-jev-router.outcome` entry for the final main assistant response. The outcome includes the actual thinking level, the stop reason, the failure category, the reported usage, and the elapsed time after routing.

A missing outcome stays missing. The outcome is not an HTTP log and does not record time to the first token. A direct request writes neither entry.

The router checks session and branch ancestry before it writes an outcome. It clears pending links at session boundaries and at agent boundaries. A classifier result that arrives after the deadline is ignored. A result is ignored when the session, the branch, or the input is no longer the one that started the call.

Decision entries and classification records omit prompts, code, tool arguments, response bodies, credentials, and raw errors. A failed write prints `diagnostics-unavailable` and leaves the route unchanged. That failure can leave usage incomplete or pending.

Diagnostics are left out of the model context. They are not a second billable usage source. Main assistant outcome usage is already in Pi's session totals.

### The `/jev-usage` command

| Command | Scope |
| --- | --- |
| `/jev-usage` | Current branch |
| `/jev-usage --session` | Every entry in the current session file, including abandoned branches |
| `/jev-usage --json` | The same summary as JSON |

A query calls no model and does not change state. `summarizeClassifierUsage(manager, virtual, scope)` returns the same summary. `virtual` defaults to provider `jev` and id `auto`. `scope` defaults to `branch`. The `apis` field lists the classifier adapters recorded on those attempts.

Each classification attempt has a random call id, a pending snapshot, and a terminal snapshot. A snapshot is counted once. A real retry after cancellation is a separate attempt. The summary counts attempts recorded by this version.

Reported tokens are not a bill. Missing usage, pending calls, and unknown or zero catalog prices stay visible. When any cost is unknown, `knownCost` is the subtotal of the known costs. A timeout or a cancelled call can still create service usage that the summary does not show.

Reopen and compaction keep the usage entries. A branch query follows ancestry. A session query includes abandoned branches. A fork includes ancestor usage. Adding a parent total to a fork total counts the shared usage twice.

On the Pi 1.2.0 live checks, direct classifier usage sat outside `/session`. After a Pi upgrade, compare host accounting with `/jev-usage` again before combining totals. Main assistant outcome records are already in Pi's session accounting.

### Thinking levels

The routed model is the catalog model that runs the request. Dispatch reads `settings.modelThinkingLevels` for the virtual model, then for the routed model, then uses the request thinking level. A retry that keeps the failed model uses `failed.thinkingLevel` before those keys. Pi clamps the level to the routed model. Example keys are `openai-codex/gpt-6-astra` and `jev/auto`.

## Privacy

By default, classifier input is the projected visible text of the last native user entry. A converted custom message, a summary, or bash output does not replace that source. Images, thinking, and tool data are excluded.

`fixed`, and the initial `shadow` classification, send a `state.prompt` payload. `adaptive` sends `state.current`. With no source entry, or with empty projected text, the router does not call the classifier.

History sharing is off by default. `adaptive.contextMode` does not change `fixed` classification or the initial shadow classification. The following file turns history on:

```json
{ "strategy": "adaptive", "adaptive": { "contextMode": "recent-conversation" } }
```

`recent-conversation` adds `state.recentTurns` and `state.historyPartial`. Adaptive classification and later shadow checks then include that history plus the current user text.

A previous turn holds native user text and successful assistant text, in time order. Assistant text counts when `stopReason` is `stop` or `toolUse`. The history omits tools, thinking, images, system messages, custom messages, summaries, and failed or aborted responses.

The newest complete turns have to fit both `adaptive.historyMaxTurns` and `adaptive.historyCharLimit`. The router drops whole oldest turns until the history fits. If the newest turn alone exceeds a budget, the history is empty. The router does not replace that turn with an older turn.

Current text uses `promptLimit`, separate from the history budgets. Those budgets leave out the classifier instructions and the JSON overhead. The router does not call a summary model to shorten history.

The router reads the text that compaction and context edits left in place. `historyPartial` means the history is incomplete. The flag does not report the classifier probability.

User text and assistant text can contain a pasted secret or file contents. The filter does not remove those secrets. Set `classifier` to `null` or `false` to stop every classifier request.

## Troubleshooting

- `jev/auto` is missing from `/model` when the package is not loaded, Pi has not been restarted, or a checkout is loaded beside the npm package. Install one copy and restart Pi.
- A configured model is missing from `pi --list-models` when `provider` or `models` does not match the catalog. Set those fields to ids from that command.
- Classification fails or times out. Initialization then uses `models.standard` when no previous planning model can be reused. A later failure keeps the current model. Set `classifier` to `null` to turn classification off. `missing-classifier` means the catalog has no `classifier` model for that provider and id. `error` means the adapter request failed. Causes include a missing credential, an unreachable endpoint, and a server error. For `llama.cpp`, raise `classifier.timeoutMs` before treating the router as failed.
- A file edit applies on the next Pi start. Pi reads the sources in [Configuration files](#configuration-files). An unknown key prints a warning.
- A write is ignored when Pi has no nested tool records and the successful write is not the outer tool result.

## Development

Run the routing and lifecycle tests:

```sh
npm test
```

Include the public `SessionManager` cases:

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

Without `PI_ROUTER_HOST_MODULE`, the host cases skip and say so. The notes in [`plans/003-final-router.md`](plans/003-final-router.md) record 232 passing tests in 27 suites. That run includes real `SessionManager` cases and a strict `tsc --noEmit` check against the installed Pi and pi-ai type declarations.

The tests use fixed classifier and catalog fixtures. They check routing and session lifecycle. They do not measure classifier accuracy, production latency, task quality, or cost. Adapter tests supply normalized results through registry mocks. Live sign-in and the wire protocol are outside those tests.

`scripts/live-agent-smoke.ts` bills the configured accounts. The script is separate from `npm test`. It uses the configured `codex-sub2api` sol and luna models and `typesafe/jev-latest`, in a temporary directory. The `core` scenario counts as validated only when the live classifier meets the guarded handoff threshold. A run that never hands off leaves that scenario unvalidated. This release has not rerun the live scenarios.

Review `scripts/live-agent-smoke.ts`, then run it:

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
```

Other scenario names are `core`, `cancel`, and `retry`.

Release steps for maintainers are in [`RELEASING.md`](RELEASING.md).

## License

MIT. The terms are in [`LICENSE`](LICENSE).
