# pi-jev-router

[简体中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/@caph42/pi-jev-router)](https://www.npmjs.com/package/@caph42/pi-jev-router)
[![license](https://img.shields.io/npm/l/@caph42/pi-jev-router)](LICENSE)

`pi-jev-router` is a [pi](https://pi.dev) extension. It registers one virtual model, `jev/auto`, and picks a physical model for every request pi sends to it.

The point is to plan on a strong model and let a cheaper model carry out the plan. The classifier only rates text. It reads no model names and no prices.

```text
agent-loop request
├─ first request of a stage           → classify → models.complex, otherwise models.standard
└─ after an eligible successful write → models.implementation, when handoff is allowed

direct request (compaction, title)
└─ models.direct → models.implementation → models.standard
```

Three strategies decide how often the router re-reads the prompt. `adaptive` is the default and re-decides at every user message and compaction. `fixed` classifies once, exchanges the planning model for the implementation model after the first successful write, and keeps it for the rest of the branch. `shadow` logs the upgrade the classifier would have triggered without changing the route.

## Installation

```sh
pi install npm:@caph42/pi-jev-router
```

Append `@<version>` to pin one release. To load a checkout without installing it:

```sh
pi -e ./extensions/jev-router.ts --model jev/auto
```

Then select **Auto (Jev)** in `/model`, or start pi with `pi --model jev/auto`.

Update with `pi update --extensions`. Load either the checkout or the npm package, not both: loading both registers `jev/auto` twice. Installing the package does not touch an existing `jev-router.json`, though the first start afterwards can, as [Updates](#updates) describes.

### Requirements

- A pi build that provides virtual models, persistent branch ids and `buildSessionProjection()`. The suite passes against pi 1.4.0; the command is under [Development](#development).
- Each configured model should appear in `pi --list-models` under `provider`. The defaults are `openai-codex` models: `gpt-6-astra` for complex work, `gpt-6.1-sol` otherwise, and `gpt-6-luna` for implementation.
- A classifier model of pi's `classifier` type is optional. The default is `typesafe/jev-latest`; see [classifier endpoints](#classifier-endpoints) for adapters. Set `classifier` to `null` or `false` to turn classification off. Under the default `adaptive` strategy, the classifier is what enables upgrades and guarded handoff.
- Node 20 or newer, as declared in `engines`. The tests for this release ran on Node 24.15.0.

If the host has no `buildSessionProjection()`, `fixed` and `shadow` send no classifier input and cannot detect a write. They still start on `models.standard` or reuse a previous planning model. `adaptive`, the default, calls the projection API and fails without it.

### Updates

The router keeps `jev-router-state.json` in the pi agent directory (`$PI_CODING_AGENT_DIR` when set) and records the version it last ran there. That file is state, not configuration.

The first start of a new version, including a fresh install, does two things once:

- The highest-precedence configuration file that sets `strategy` to anything other than `adaptive` is rewritten to `adaptive`, and the router prints which file changed. Only that file is touched, and the running process adopts the new value without a restart.
- When no configuration file sets `provider`, `models`, or `classifier`, the router prints the file to set them in: the personal `jev-router.json`, or the file named by `$JEV_ROUTER_CONFIG`. Any one of the three keys counts as configured, and the reminder stops.

The switch is attempted once per state file, whether or not any file set `strategy`. If you set it back to `fixed` afterwards, later updates leave it alone. The scope is one agent directory, so the first project started under it consumes the switch for every project that shares the directory.

The notice arrives as a UI notification, or on stdout when the host has no UI. It needs the host's `session_start` event; a host without that event loads the router and skips the notice.

Nothing is printed when the version is unchanged. Delete `jev-router-state.json` to repeat both steps on the next start.

## Strategies

The router plans on either `models.complex` or `models.standard`. Before classifying, it reuses an available previous planning model.

`adaptive` is the default. It classifies the first user message, plans on the chosen model, and re-decides at every new user message and every compaction. It upgrades to `models.complex` when the classifier is confident, downgrades to `models.standard` after enough turns in complex, and hands off to `models.implementation` when the work looks cheap and every guarded condition holds.

`fixed` classifies once and hands off to `models.implementation` after the first successful `edit` or `write` in that turn. Later user messages keep the current model, so the rest of the branch runs on the implementation model.

`shadow` routes exactly like `fixed`. It still classifies new user messages and logs the upgrade it would have made.

| Strategy | First request | After a successful write | Later user messages |
| --- | --- | --- | --- |
| `fixed` | Classify once, or reuse an available previous planning model | Hand off to `models.implementation` | Keep the current model |
| `adaptive` (default) | Same choice. `handoffPolicy` is `guarded` by default | Hand off when every guarded condition holds | Re-decide at each new user message and compaction. Upgrade when eligible; downgrade subject to `minDwellTurns`; re-arm handoff when eligible |
| `shadow` | Same route as `fixed` | Same route as `fixed` | Record the upgrade and keep the `fixed` model |

When the first classification is unavailable, the router selects `models.standard`. When a later classification is unavailable, the router keeps the current model.

A missing initial model, a missing `models.direct` target, or a missing `models.standard` model fails the request with a configuration error. A missing handoff target or upgrade target keeps the current model. A model saved in state that is no longer in the catalog is replaced with `models.standard`, and that recovered state locks handoff.

A classifier call sends the projected text with `maxRetries` set to 0, and it stops at the local deadline. An eligible retry stays on the failed model; [Retries](#retries) lists the conditions. Cancellation aborts routing and returns no candidate state. A direct request skips classification and saved state, and cancellation stops it the same way.

## Configuration

The default `adaptive` strategy needs no config file when an OpenAI Codex login can see the default models. This file turns on diagnostics:

```json
{
  "diagnostics": { "record": true }
}
```

A Codex login covers the default models, and the default classifier needs a TypeSafe credential. With no usable classifier, `adaptive` has no probability for the current input. It reuses an available planning model or starts on `models.standard`, guarded handoff stays off, and upgrades stay off. To reach `models.implementation` without a classifier, set `"adaptive": { "handoffPolicy": "first-write" }` or switch to `"strategy": "fixed"`.

pi reads the configuration at startup, so restart pi after an edit. [`jev-router.example.json`](jev-router.example.json) lists every built-in default.

### Configuration files

pi reads the files in this table.

| Source | Scope |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | That file alone. pi reads no other config file. |
| `~/.pi/agent/jev-router.json` | Personal file. With `PI_CODING_AGENT_DIR` set, the personal file is `$PI_CODING_AGENT_DIR/jev-router.json`. |
| `<project>/.pi/jev-router.json` | Project file, merged over the personal file. |

Nested objects merge. An array in a later file replaces that array. A missing file is valid, a malformed file fails startup, and an unknown key prints a warning and is ignored.

### Route fields

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `adaptive` | `adaptive` (default), `fixed`, or `shadow` |
| `provider` | `openai-codex` | Provider that holds the slot models |
| `models.complex` | `gpt-6-astra` | Planning model for work the classifier marks complex |
| `models.standard` | `gpt-6.1-sol` | Planning model otherwise, and the fallback when the first classification is unavailable |
| `models.implementation` | `gpt-6-luna` | Model after handoff. `null` or `false` turns handoff off |
| `models.direct` | `null` | Model for direct requests. `null` uses `models.implementation`, then `models.standard` |
| `classifier.provider` | `typesafe` | Classifier provider. `null` or `false` on `classifier` turns classification off |
| `classifier.id` | `jev-latest` | Classifier model id |
| `classifier.temperature` | omitted | Divisor for label logits before normalization. Greater than 0 and at most 100 |
| `classifier.timeoutMs` | omitted | Deadline for one classifier call, an integer from 1 to 60000. Replaces `adaptive.decisionTimeoutMs` for that call |
| `threshold` | `0.5` | Probability at or above this value selects `models.complex`. From 0 to 1 |
| `promptLimit` | `16000` | Current-text limit in UTF-16 code units. From 1 to 1000000 |
| `adaptive.decisionTimeoutMs` | `3000` | Local deadline for classification, an integer from 1 to 60000. Applies to every strategy |

`classifier.temperature` is read by adapters that rank label probabilities; other adapters ignore it. Omitting `classifier.temperature` or `classifier.timeoutMs` keeps the inherited value.

The deadline field keeps the name `adaptive.decisionTimeoutMs` so older files still parse. 3000 milliseconds is the compatibility default.

### Classifier endpoints

`classifier.provider` and `classifier.id` name a model whose pi type is `classifier`. The router does not parse endpoint URLs. The catalog entry selects the adapter.

| API | Example model | Credentials | Notes |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | Default. The model has no catalog price, so `/jev-router usage` reports its cost as unknown. |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` | Also used for Jev models on Workers AI. |
| `llama-cpp-classify` | A chat model on a `llama.cpp` router | pi's `/login llama.cpp` connection. A server API key is optional. | Needs llama.cpp `/tokenize`, `/apply-template`, and `/completion`. |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | A ChatGPT login from `/login` does not provide this key. Log out of the `openai` provider before using the key. |

`llama-cpp-classify` renders the classifier state twice. Set `classifier.timeoutMs` long enough for tokenization, templating, and the probability read. Raw label probabilities from llama.cpp are often overconfident; a `classifier.temperature` greater than 1 divides the logits before normalization, which pulls a probability near 0 or 1 back toward the middle.

Models on `openrouter`, `vercel-ai-gateway`, and `opencode` proxy the System One format and use that provider's credentials.

A classifier missing from the catalog yields `missing-classifier`, and an adapter failure yields `error`. With no previous planning model to reuse, initialization selects `models.standard`; a later failure keeps the current model. Neither result allows guarded handoff.

Set `threshold` again after you change the classifier, the model, or `classifier.temperature`. Each of those changes the probability scale.

### Adaptive fields

| Field | Default | Meaning |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`, or `first-write` for the older handoff rule |
| `adaptive.handoffThreshold` | `0.2` | Highest complex probability that still allows guarded handoff. From 0 to 1 |
| `adaptive.maxHandoffContextTokens` | `50000` | Largest context estimate that still allows guarded handoff. An integer from 1 to the maximum safe integer |
| `adaptive.handoffTools` | `edit`, `write` | Tool names whose success can hand off under `adaptive` |
| `adaptive.downgradeThreshold` | `0.15` | Complex can downgrade at or below this probability. Must be below `threshold` |
| `adaptive.minDwellTurns` | `2` | Evaluated user turns required in complex before downgrade, from 1 to 20 |
| `adaptive.historyMaxTurns` | `4` | Earlier complete turns to keep. An integer from 1 to 8 |
| `adaptive.historyCharLimit` | `8000` | History text limit in UTF-16 code units. An integer from 1 to 32000 |

Handoff fields apply to `adaptive`. `fixed` and `shadow` treat a successful `edit` or `write` as a write, including a successful nested call.

An empty `adaptive.handoffTools` array turns adaptive handoff off. `bash` and `codemode` are rejected. A successful wrapper tool is not a write. A custom name is valid when success from that tool means the work moved to implementation.

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

After the first route, the virtual model reports the routed model's context window and max output.

`strategy`, `adaptive`, and `diagnostics` reject `null` and other invalid values. `classifier.temperature` and `classifier.timeoutMs` reject `null` as well. `models.implementation`, `models.direct`, and `classifier` accept `null` or `false`.

## Routing decisions

### The first request

On initialization, the router reuses an available previous planning model. With no planning model available, it classifies the current native user entry once.

The native user entry is the last projection source whose original role is `user`. The classifier reads that entry's projected visible text. A converted custom message, a summary, or bash output does not replace that source. The entry can come from the SDK or another extension, so a `user` role does not mean a person typed the text. A transform that exists for one request does not replace the stored projection.

A probability at or above `threshold` selects `models.complex`. A lower probability selects `models.standard`. When classification is unavailable, initialization selects `models.standard`, and a later failure keeps the current model.

### Handoff to the implementation model

Guarded adaptive handoff requires all of the following:

- The resulting slot is `models.standard`. The complex probability was valid, below `threshold`, and at most `adaptive.handoffThreshold`. A reused planning model has no stored probability, and guarded handoff needs one.
- The current native projected text is non-empty, within `promptLimit`, and has no image. The classifier input still matches the input used for the decision, which the state tracks as a SHA-256 digest.
- A successful call from `adaptive.handoffTools` appears after both the current native user entry and `stageStartEntryId`.
- The context-token estimate is finite, zero or greater, and at most `adaptive.maxHandoffContextTokens`.
- `models.implementation` is still in the catalog.

A complex selection locks handoff. Disabled classification, a missing classifier, an invalid answer, an error, or a timeout does not allow guarded handoff. A new user boundary replaces the previous handoff evidence.

A nested call with status `ok` counts even when the outer tool later fails or its record is incomplete. The call shows that a write finished, not that the whole task finished. A failed or unfinished nested call does not count. Tool arguments do not count, prose that says the file was written does not count, and a successful wrapper tool does not count.

The check uses entry ids on the current branch. A write before `stageStartEntryId`, or before the current native user entry, does not start this handoff. Without nested tool records, pi recognizes a successful outer write and does not recognize a nested write.

### Upgrades and downgrades

Each new native user entry is assessed once, including on complex. A probability at or above `threshold` upgrades a non-complex slot. Complex downgrades to standard when the probability is at or below `adaptive.downgradeThreshold`, the current input is complete, and `adaptive.minDwellTurns` evaluated user turns have elapsed in the slot. Incomplete input prevents downgrade, and unavailable classification keeps the model. A slot change resets the dwell count, and a branch may upgrade and hand off more than once.

Each new compaction entry also triggers one assessment, on the next user or continuation request. Compaction does not increase the dwell count. A new user entry and a compaction together cause one assessment, and a retry does not consume a pending compaction. Re-enabling handoff sets a new write boundary, so earlier writes cannot trigger it.

To keep the older first-write rule, set the policy in config:

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` allows handoff from standard even when classification was unavailable. It skips the text checks and the context-token limit. Complex remains locked.

### Retries

A retry neither classifies nor hands off. It keeps the failed model when that model is still available on the configured provider, and the failed id matches a configured model id or the id already stored in state. It also keeps the failed model's thinking level. When those checks fail, the retry uses valid state, an available previous planning model, or `models.standard`.

A retry whose selected model matches the valid state model keeps the handoff state, including when it falls back to that model. A retry onto a different model locks handoff. Repeating a retry does not append a second copy of the same state. pi stores the returned state before it sends the main request, and a later model failure does not undo that stored state.

### Deadlines and cancellation

`adaptive.decisionTimeoutMs` is the local deadline, and it applies to every strategy. When `classifier.timeoutMs` is set, the classifier call uses that value instead. If the deadline is reached first, a later success or failure is ignored.

Caller cancellation or a service abort stops routing and returns no candidate state. A direct request skips classification and saved state, and cancellation stops that request too.

### Saved state and migration

Adaptive state uses `schemaVersion` 1 and `policyVersion` `"adaptive-v3"`. Older phase and model state, `adaptive-v1`, and `adaptive-v2` migrate with handoff locked, and existing compactions are marked handled during migration.

A configuration change, a provider change, or a lost `stageStartEntryId` ends the previous handoff. Invalid adaptive state fails with `invalid adaptive state; start a new session or switch strategy to fixed`.

`fixed` reads adaptive phase and model state. Setting `strategy` to `fixed` restores fixed handoff. Fixed state records the provider, the handoff lock, and `stageStartEntryId`. State follows resume, compaction, and branch ancestry, and a new session starts with no saved routing state.

## Shadow mode

`shadow` uses the `fixed` route and classifies the initial prompt. On a later native user entry, while the slot is not `models.complex`, `shadow` reads the same input `adaptive` would use, then keeps the current model or names an upgrade.

stderr carries a line with `proposedModel`, `available`, and `applied` set to false. The line is printed when `debug` is off. When `debug` is on, the debug log carries the same decision. `shadow` keeps the `fixed` model, and the logged model is the upgrade it would have selected. The fields include no quality score and no cost delta.

The last assessed entry id is stored, so reopening a session does not classify that entry again. A retry and a continuation do not run shadow classification.

## The `/jev-router` command

Every subcommand is reachable through one namespaced command:

| Command | Scope |
| --- | --- |
| `/jev-router status` | The configuration loaded at startup: strategy, models, classifier, diagnostics, debug, and the config files pi read |
| `/jev-router usage` | Current branch |
| `/jev-router usage --session` | Every entry in the current session file, including abandoned branches |
| `/jev-router usage --json` | The same summary as JSON |
| `/jev-router help` | This list. Bare `/jev-router` prints it too |

`/jev-usage` is gone; use `/jev-router usage` with the same `--session` and `--json` flags. pi treats an unknown slash command as an ordinary message, so the old spelling is sent to the model instead of failing. Update scripts that still use it.

`status` and `usage` call no model and change no state. `status` reports the configuration loaded at startup, not live routing and not whether a model or classifier is available. It also names the config files pi actually read, so a missing or unexpected file is visible. Restart pi after editing a config file. Both subcommands work on a host without a UI by writing to stdout.

A usage query reports the same summary as `summarizeClassifierUsage(manager, virtual, scope)`. `virtual` defaults to provider `jev` and id `auto`, and `scope` defaults to `branch`. The `apis` field lists the classifier adapters recorded on those attempts.

Each classification attempt has a random call id, a pending snapshot, and a terminal snapshot. A snapshot is counted once, and a real retry after a cancellation is a separate attempt. The summary counts attempts recorded by this version.

Reported tokens are not a bill. Missing usage, pending calls, and unknown or zero catalog prices stay visible. When any cost is unknown, `knownCost` is the subtotal of the known costs. A timeout or a cancelled call can still create service usage that the summary does not show.

Reopening a session and compacting keep the usage entries. A branch query follows ancestry, a session query includes abandoned branches, and a fork includes ancestor usage. Adding a parent total to a fork total counts the shared usage twice.

On pi 1.2.0, `/session` counted only host usage, so direct classifier usage sat outside it. After a pi upgrade, compare host accounting with `/jev-router usage` again before combining totals. Main assistant outcome records are already in pi's session accounting.

### Thinking levels

The routed model is the catalog model that runs the request. Dispatch reads `settings.modelThinkingLevels` for the virtual model, then for the routed model, then uses the request thinking level. A retry that keeps the failed model uses `failed.thinkingLevel` before those keys. pi clamps the level to the routed model. Example keys are `openai-codex/gpt-6-astra` and `jev/auto`.

## Diagnostics

Set `diagnostics.record` to true to store entries.

A `pi-jev-router.decision` entry includes `decisionReason`, the source model, the target model, and the requested thinking level. It also includes `classifierStatus`, `classifierApi`, the probability, the duration, safe usage, and the context estimate.

A random `decisionId` links that entry to the `pi-jev-router.outcome` entry for the final main assistant response. The outcome includes the actual thinking level, the stop reason, the failure category, the reported usage, and the elapsed time after routing.

A missing outcome stays missing. The outcome is not an HTTP log and does not record time to the first token. A direct request writes neither entry.

The router checks session and branch ancestry before it writes an outcome, and it clears pending links at session and agent boundaries. A classifier result that arrives after the deadline is ignored. A result is ignored when the session, the branch, or the input is no longer the one that started the call.

Decision entries and classification records omit prompts, code, tool arguments, response bodies, credentials, and raw errors. A failed write prints `diagnostics-unavailable` and leaves the route unchanged, which can leave usage incomplete or pending.

Diagnostics stay out of the model context. They are not a second billable usage source, because main assistant outcome usage is already in pi's session totals.

## Privacy

By default, classifier input is the projected visible text of the last native user entry. A converted custom message, a summary, or bash output does not replace that source. Images, thinking, and tool data are excluded.

`fixed` and the initial `shadow` classification send a `state.prompt` payload, and `adaptive` sends `state.current`. With no source entry, or with empty projected text, the router does not call the classifier.

Adaptive classification and later shadow checks always include `state.recentTurns` and `state.historyPartial` alongside the current user text. The removed `adaptive.contextMode` is ignored with a warning. Fixed and initial shadow classification remain unchanged.

A previous turn holds native user text and successful assistant text, in time order. Assistant text counts when `stopReason` is `stop` or `toolUse`. The history omits tools, thinking, images, system messages, custom messages, summaries, and failed or aborted responses.

The newest complete turns have to fit both `adaptive.historyMaxTurns` and `adaptive.historyCharLimit`. The router drops whole oldest turns until the history fits. If the newest turn alone exceeds a budget, the history is empty, and the router does not replace that turn with an older one.

Current text uses `promptLimit`, separate from the history budgets. Those budgets leave out the classifier instructions and the JSON overhead. The router does not call a summary model to shorten history.

Classification reads the text that compaction and context edits left in the projection. The router sets `historyPartial` when that history is incomplete, and the flag does not report the classifier probability.

User text and assistant text can contain a pasted secret or file contents, and the filter does not remove those secrets. Set `classifier` to `null` or `false` to stop every classifier request.

## Troubleshooting

- `jev/auto` is missing from `/model` when the package is not loaded, pi has not been restarted, or a checkout is loaded beside the npm package. Install one copy and restart pi.
- A configured model is missing from `pi --list-models` when `provider` or `models` does not match the catalog. Set those fields to ids from that command.
- Classification fails or times out. Initialization then uses `models.standard` when no previous planning model can be reused, and a later failure keeps the current model. Set `classifier` to `null` to turn classification off.
- `missing-classifier` means the catalog has no `classifier` model for that provider and id. `error` means the adapter request failed, from a missing credential, an unreachable endpoint, or a server error. For `llama.cpp`, raise `classifier.timeoutMs` before treating the router as failed.
- A config edit applies on the next pi start, because pi reads the sources in [configuration files](#configuration-files). An unknown key prints a warning.
- A write is ignored when pi has no nested tool records and the successful write is not the outer tool result.
- `adaptive` never upgrades and never performs guarded handoff when classification is unavailable. Without a reusable planning model it starts on `models.standard`. Configure a classifier, set `"handoffPolicy": "first-write"`, or switch to `fixed`.

## Development

Run the routing and lifecycle tests:

```sh
npm test
```

Include the public `SessionManager` cases:

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

Without `PI_ROUTER_HOST_MODULE`, the host cases skip and say so. Against pi 1.4.0 on Node 24.15.0 the suite reports 309 tests in 32 suites. Without the host module, 301 pass and 8 skip; with it, all 309 pass.

The tests use fixed classifier and catalog fixtures. They check routing and session lifecycle. They do not measure classifier accuracy, production latency, task quality, or cost. Adapter tests supply normalized results through registry mocks, and live sign-in and the wire protocol are outside those tests.

`scripts/live-agent-smoke.ts` bills the configured accounts. It runs separately from `npm test`, uses the configured `codex-sub2api` sol and luna models and `typesafe/jev-latest`, and runs in a temporary directory. The `core` scenario counts as validated only when the live classifier meets the guarded handoff threshold; a run that never hands off leaves that scenario unvalidated. This release has not rerun the live scenarios.

Review `scripts/live-agent-smoke.ts`, then run it:

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
```

The other scenario names are `core`, `cancel`, and `retry`. Release steps for maintainers are in [`RELEASING.md`](RELEASING.md).

## License

MIT. The terms are in [`LICENSE`](LICENSE).
