# pi-jev-router

A virtual model for [pi](https://pi.dev) that **plans on a strong model and implements on a cheap
one**. It registers one selectable model (default `jev/auto`) and routes each request by phase and
by how demanding the task is.

```
                     ┌── Jev: complex ──→ gpt-6-astra     ┐
 user message ──────→│                                    │──→ first edit ──→ gpt-6-luna
                     └── otherwise ─────→ gpt-6.1-sol     ┘     (rest of the session)
```

- **Planning** — the first user message of a session is rated by the Jev classifier. Demanding work
  goes to `models.complex`, everything else to `models.standard`. Planning stays on that model for
  the whole planning phase.
- **Implementation** — after the first successful `edit` or `write` tool call, the next request of
  the same turn goes to `models.implementation`, and the session stays there.

A session switches models exactly once, so it pays a single prompt-cache miss. The phase is router
state, which pi stores on the session branch: it follows the session tree, survives compaction and
forks, and is restored when you resume.

This is a configurable package version of pi's `examples/extensions/jev-router.ts`, the reference
router. pi's `docs/virtual-models.md` documents the virtual-model API it builds on; both files ship
inside the pi package.

## Requirements

- pi with virtual-model support (`pi --list-models` shows your catalog).
- A catalog the router can reach. The defaults are three models of pi's `openai-codex` provider, so
  an OpenAI Codex login is the whole setup. To route other models, set `provider` and `models`
  yourself — see [Configure](#configure).
- Optional: TypeSafe credentials (`TYPESAFE_API_KEY`) for the Jev classifier. Without them, planning
  always uses `models.standard` — routing still works, it just skips the complexity rating.

## Install

```sh
# from npm
pi install npm:@caph42/pi-jev-router

# from git
pi install git:github.com/Caph-dev/pi-jev-router

# from a local checkout (loaded in place, no copy)
pi install ./path/to/pi-jev-router

# one-off, without installing
pi -e npm:@caph42/pi-jev-router --model jev/auto
```

Then pick the model:

```sh
pi --model jev/auto
```

or select **Auto (Jev)** in `/model`. To make it the default, set `defaultProvider` and
`defaultModel` in `~/.pi/agent/settings.json`.

> Loading this extension twice (for example from both `~/.pi/agent/extensions/` and this package)
> registers the virtual model twice. Keep one.

## Configure

**A config file is optional.** The built-in defaults are three models of pi's `openai-codex`
provider, so with an OpenAI Codex login `pi --model jev/auto` works as installed. Write one when your
models live under another provider, or when you want different ones:

```json
{
  "provider": "anthropic",
  "models": {
    "complex": "claude-sonnet-4-5",
    "standard": "claude-haiku-4-5",
    "implementation": "claude-haiku-4-5"
  }
}
```

`pi --list-models` prints the provider and model ids you have. With `$JEV_ROUTER_CONFIG` set, that
file is the only one read. Otherwise pi reads both of the others, the project file over the personal
one:

| Source | Scope |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | explicit file; when set, no other file is read |
| `~/.pi/agent/jev-router.json` | personal; `$PI_CODING_AGENT_DIR` moves the `~/.pi/agent` directory |
| `<project>/.pi/jev-router.json` | project (overrides the personal file) |

A missing file is fine. A malformed one fails loudly at startup — pi names the file and the parse
or type error, and the virtual model stays unavailable until you fix it. Nothing is routed silently
with a config you did not intend: an unknown key, at any nesting level, is reported on stderr and
ignored, so a typo never changes routing quietly. Configuration is read when pi starts — restart pi
after editing it.

[`jev-router.example.json`](./jev-router.example.json) spells out every key with its default value.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `openai-codex` | Provider that holds the physical models. |
| `models.complex` | `gpt-6-astra` | Planning model for demanding work. |
| `models.standard` | `gpt-6.1-sol` | Planning model otherwise, and the fallback when the classifier is unavailable or fails. |
| `models.implementation` | `gpt-6-luna` | Implementation model. `null` keeps every request on the planning model. |
| `models.direct` | `null` | Model for requests outside the agent loop (compaction summaries, titles). `null` follows `implementation`, then `standard`. |
| `virtual.provider` | `jev` | Provider the virtual model is listed under. A provider id pi has no physical models for is always available. |
| `virtual.id` | `auto` | Model id, so the default selection is `jev/auto`. Must not collide with a physical model of that provider. |
| `virtual.name` | `Auto (Jev)` | Display name in `/model`. |
| `virtual.thinkingLevels` | `["low","medium","high","xhigh","max"]` | Thinking levels offered for selection. |
| `virtual.contextWindow` | `272000` | Limits shown before the first response; pi adopts the routed model's limits afterwards. |
| `virtual.maxTokens` | `128000` | Same, for max output. |
| `classifier` | `{"provider":"typesafe","id":"jev-latest"}` | Jev classifier that rates the planning prompt. `null` or `false` disables classification. |
| `threshold` | `0.5` | Probability at or above which a prompt counts as complex. |
| `promptLimit` | `16000` | Characters of the last user message sent to the classifier. |
| `debug` | `false` | Log routing decisions to stderr. |

`virtual.contextWindow` and `virtual.maxTokens` default to `272000` / `128000` — the real limits of
the three default models, so the numbers pi shows before the first response already match the model
the router picks.

Anything sent to a classifier leaves your machine: the last user message, up to `promptLimit`
characters, and nothing else — no tool results, no files. Set `classifier` to `null` to send nothing
at all and skip the rating.

## Thinking levels

The **dispatched** level comes from pi's per-model setting, so each routed model runs at its own
configured strength:

```json
{
  "modelThinkingLevels": {
    "openai-codex/gpt-6-astra": "xhigh",
    "openai-codex/gpt-6.1-sol": "high",
    "openai-codex/gpt-6-luna": "max"
  }
}
```

`modelThinkingLevels["jev/auto"]` (the virtual model's own key) overrides all of them and pins one
level for the whole route. Levels are clamped per routed model by pi. The footer shows selection and
dispatch side by side, e.g. `auto • max → gpt-6-astra • xhigh`, and `/session` breaks the cost down
per physical model.

## Behavior

| Request | Routed model |
| --- | --- |
| First user message of a session | Jev rating: `complex` → `models.complex`, otherwise `models.standard` |
| Later requests of the same turn | the planning model in state (no mid-turn switch) |
| After a successful `edit` / `write` | `models.implementation` for the rest of the session |
| Retry after a failed request | the model already in state |
| Outside the agent loop (compaction, summaries) | `models.direct`, else `models.implementation`, else `models.standard` |
| Classifier missing, erroring, or low confidence | `models.standard` |
| State names a model that is no longer in the catalog | `models.standard`, and the session continues |

Limits follow the route. The virtual model declares `virtual.contextWindow` / `virtual.maxTokens`
for the window before the first response; each route then re-registers the virtual model with the
routed model's real limits (registering the same provider and id again replaces the definition), so
the declared numbers track the model that actually ran. With the default models the two already
match, and nothing changes.

## Debugging

```sh
JEV_ROUTER_DEBUG=1 pi --model jev/auto
```

```
[pi-jev-router] config: built-in defaults
[pi-jev-router] planning openai-codex/gpt-6-astra | openai-codex/gpt-6.1-sol → openai-codex/gpt-6-luna
[pi-jev-router] classify → openai-codex/gpt-6-astra (complex p=0.913, threshold 0.5)
[pi-jev-router] user → openai-codex/gpt-6-astra • xhigh • ctx 272000/128000
[pi-jev-router] continuation → openai-codex/gpt-6-luna • max • ctx 272000/128000
```

Each route starts with pi's `reason` for the request (`user`, `continuation`, `direct`, `retry`),
followed by the model, the thinking level actually dispatched, and the context window and max output
of that model. The `config:` line names the files that were read, or `built-in defaults` when there
are none. The same output is available with `"debug": true` in the config file.

## 中文速览

**做什么**：注册一个虚拟模型（默认 `jev/auto`），按阶段分流 —— 用前的第一个用户消息交给 Jev
分类器判定复杂度，复杂的走 `models.complex`，其余走 `models.standard`；规划完成后第一次成功
`edit`/`write` 之后，整个会话切到 `models.implementation`，一个会话只切一次模型，只付一次
prompt cache 失效的代价。阶段状态存在会话分支上，压缩、分叉、resume 都保留。

**安装**：`pi install npm:@caph42/pi-jev-router`（或 `pi install git:github.com/Caph-dev/pi-jev-router`），然后
`pi --model jev/auto`；只想试一次用 `pi -e npm:@caph42/pi-jev-router --model jev/auto`。

**配置**：可以不写配置文件 —— 内置默认值就是 `openai-codex` 的 gpt-6-astra / gpt-6.1-sol /
gpt-6-luna，有 OpenAI Codex 登录就能直接跑。要换成自己的模型时：设了 `$JEV_ROUTER_CONFIG` 就只读它；
否则先读 `~/.pi/agent/jev-router.json`，再读 `<项目>/.pi/jev-router.json`（后者覆盖前者）。
改完需要重启 pi：

```json
{
  "provider": "anthropic",
  "models": { "complex": "claude-sonnet-4-5", "standard": "claude-haiku-4-5", "implementation": "claude-haiku-4-5" }
}
```

**强度**：派发强度读 `modelThinkingLevels` 里每个物理模型自己的设置，例如
`"modelThinkingLevels": {"openai-codex/gpt-6-astra": "xhigh", "openai-codex/gpt-6.1-sol": "high",
"openai-codex/gpt-6-luna": "max"}`；`modelThinkingLevels["jev/auto"]` 可以一键覆盖全部。

**隐私**：送进分类器的只有最后一条用户消息（截断到 `promptLimit` 字符），不发工具结果；设
`"classifier": null` 可完全关闭（写 `false` 等价）。

**排查**：`JEV_ROUTER_DEBUG=1 pi --model jev/auto`，或配置里 `"debug": true`。

## Development

Developing from a checkout: `pi install ./path/to/pi-jev-router` loads the extension in place, so
edits take effect on the next pi start. `npm test` runs the tests. Maintainer notes for cutting a
release live in [RELEASING.md](./RELEASING.md).

## License

MIT
