# pi-jev-router

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@caph42/pi-jev-router)](https://www.npmjs.com/package/@caph42/pi-jev-router)
[![license](https://img.shields.io/npm/l/@caph42/pi-jev-router)](LICENSE)

`pi-jev-router` 是 [pi](https://pi.dev) 的扩展。它注册一个虚拟模型 `jev/auto`，把每个 agent 循环请求路由到一个已配置的模型槽位。

Agent 循环请求使用 `models.complex`、`models.standard` 或 `models.implementation`。直接请求，例如压缩或标题，在设置了 `models.direct` 时使用该字段。否则直接请求先用 `models.implementation`，再用 `models.standard`。路由读取配置和分类器结果。模型名称和价格不参与选择。

## 安装

安装已发布的包：

```sh
pi install npm:@caph42/pi-jev-router
```

固定到一个版本：

```sh
pi install npm:@caph42/pi-jev-router@1.0.2
```

不安装，直接加载 checkout：

```sh
pi -e ./extensions/jev-router.ts --model jev/auto
```

在 `/model` 里选择 **Auto (Jev)**，或用 `pi --model jev/auto` 启动 Pi。

用 `pi update --extensions` 升级。只加载 checkout 或 npm 包中的一个。两个一起加载会把 `jev/auto` 注册两次。安装这个包不会改动已有的 `jev-router.json`。

### 环境要求

- Pi 提供虚拟模型、持久分支 id 和 `buildSessionProjection()`。本包在 Pi 1.3.0 上验证过。
- `models.complex`、`models.standard`，以及配置了的 `models.direct`，要能在 `pi --list-models` 里解析到。默认是 `openai-codex` 模型：`gpt-6-astra`、`gpt-6.1-sol` 和 `gpt-6-luna`。
- 分类器可选。默认模型是 `typesafe/jev-latest`。Pi 的 `classifier` 类型模型都可以用。适配器列在[分类器端点](#分类器端点)。把 `classifier` 设为 `null` 或 `false` 可关闭分类。
- 使用已安装的 Pi 所支持的 Node 版本。本包允许 Node 20 或更高版本。本版本的 TypeScript 测试运行在 Node 24.15.0。

没有 `buildSessionProjection()` 时，`fixed` 和 `shadow` 不向分类器发送输入，也不检测写入。初始化仍可以选择 `models.standard`，或复用上一规划模型。`adaptive` 会调用投影 API。没有这些 API 时，`adaptive` 失败。

## 策略

规划模型是已配置 provider 上的 `models.complex` 或 `models.standard`。路由在分类之前复用可用的上一规划模型。

`fixed` 是默认策略。它的路径如下：

```text
初始化时的当前原生用户条目
       │
       ▼
     分类
    ├─ complex   → models.complex ──┐
    └─ 其他      → models.standard ─┤
                                    └─ 成功的 edit 或 write → models.implementation
```

| 策略 | 初始规划 | 成功写入之后 | 之后的原生用户条目 |
| --- | --- | --- | --- |
| `fixed` | 分类一次，或复用可用的上一规划模型 | 交接给 `models.implementation` | 保持当前模型 |
| `adaptive` | 同样的选择。默认是守卫式交接 | 守卫条件全部成立时交接 | 每个新用户条目和每次压缩后重新判定。可升级或按 `minDwellTurns` 限制降级，符合条件时重新启用交接 |
| `shadow` | 与 `fixed` 相同的路由 | 与 `fixed` 相同的路由 | 记录这次升级，并保持 `fixed` 的模型 |

第一次分类不可用时，路由选择 `models.standard`。之后的分类不可用时，路由保持当前模型。

初始选中的模型缺失，是配置错误。`models.direct` 的目标缺失，是配置错误。`models.standard` 缺失，是配置错误。交接目标或升级目标缺失时，保持当前模型。状态里保存的模型已经不在模型目录中时，路由把它换成 `models.standard`，并锁定交接。

每种策略都发送投影后的原生文本，并以 `maxRetries` 为 0 调用分类器。调用在本地期限到达时停止。重试留在失败的模型上。取消会中止路由，并且不返回候选状态。直接请求跳过分类和已保存的状态。取消仍会中止该请求。

## 配置

已有 OpenAI Codex 登录，并且能看到默认模型时，默认的 `fixed` 策略不需要配置文件。下面的文件选择 `adaptive`，并记录诊断：

```json
{
  "strategy": "adaptive",
  "diagnostics": { "record": true }
}
```

Codex 登录覆盖默认模型。默认分类器需要 TypeSafe 凭据。没有可用分类器时，`adaptive` 没有当前输入的概率。`adaptive` 复用可用的规划模型，或从 `models.standard` 开始。守卫式交接保持关闭。分类器升级保持关闭。

Pi 在启动时读取配置。修改后重启 Pi。[`jev-router.example.json`](jev-router.example.json) 列出全部内置默认值。

### 配置文件

Pi 读取下表中的文件。

| 来源 | 范围 |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | 只读该文件。Pi 不读其他配置文件。 |
| `~/.pi/agent/jev-router.json` | 个人文件。设置了 `PI_CODING_AGENT_DIR` 时，个人文件是 `$PI_CODING_AGENT_DIR/jev-router.json`。 |
| `<project>/.pi/jev-router.json` | 项目文件，合并并覆盖个人文件。 |

嵌套对象会合并。后面文件里的数组会替换对应的数组。缺少文件是允许的。格式错误会让启动失败。未知键会打印警告，并被忽略。

### 路由字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `strategy` | `fixed` | `fixed`、`adaptive` 或 `shadow` |
| `provider` | `openai-codex` | 存放槽位模型的 provider |
| `models.complex` | `gpt-6-astra` | 分类器标为 complex 的工作所用的规划模型 |
| `models.standard` | `gpt-6.1-sol` | 其他情况下的规划模型，也是第一次分类不可用时使用的模型 |
| `models.implementation` | `gpt-6-luna` | 交接之后的模型。`null` 或 `false` 关闭交接 |
| `models.direct` | `null` | 直接请求使用的模型。`null` 时先用 `models.implementation`，再用 `models.standard` |
| `classifier.provider` | `typesafe` | 分类器 provider。把 `classifier` 设为 `null` 或 `false` 会关闭分类 |
| `classifier.id` | `jev-latest` | 分类器模型 id |
| `classifier.temperature` | 省略 | 归一化之前，用来除 label logits 的数。大于 0，且至多 100 |
| `classifier.timeoutMs` | 省略 | 单次分类器调用的期限，从 1 到 60000 的整数。对该调用替换 `adaptive.decisionTimeoutMs` |
| `threshold` | `0.5` | 概率达到或超过该值时选择 `models.complex`。范围从 0 到 1 |
| `promptLimit` | `16000` | 当前文本上限，单位是 UTF-16 code unit。从 1 到 1000000 的数 |
| `adaptive.decisionTimeoutMs` | `3000` | 分类的本地期限，从 1 到 60000 的整数。适用于每种策略 |

按 label 概率排序的适配器会读取 `classifier.temperature`。其他适配器忽略它。省略 `classifier.temperature` 或 `classifier.timeoutMs` 时，保留继承到的值。

期限字段保留 `adaptive.decisionTimeoutMs` 这个名字，这样更旧的文件仍然能被解析。3000 毫秒是兼容用的默认值。

### 分类器端点

`classifier.provider` 和 `classifier.id` 指向一个 Pi 类型为 `classifier` 的模型。路由不解析端点 URL。模型目录中的条目选择适配器。

| API | 示例模型 | 凭据 | 说明 |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | 默认。直连模型没有目录价格，所以 `/jev-usage` 把它的成本报为 unknown。 |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` | Workers AI 上的 Jev 模型也使用它。 |
| `llama-cpp-classify` | `llama.cpp` router 上的一个 chat 模型 | Pi 的 `/login llama.cpp` 连接。服务端 API key 可以不填。 | 需要 llama.cpp 的 `/tokenize`、`/apply-template` 和 `/completion`。 |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | `/login` 的 ChatGPT 登录不提供这个 key。使用这个 key 之前，先退出 `openai` provider 的登录。 |

`llama-cpp-classify` 把分类器的 state 渲染两次。把 `classifier.timeoutMs` 设得够长，盖住分词、套用模板和读取概率。llama.cpp 的原始 label 概率常常过于自信。`classifier.temperature` 大于 1 时，会在归一化之前除 logits。这次除法让接近 0 或 1 的概率不那么极端。

`openrouter`、`vercel-ai-gateway` 和 `opencode` 上的模型代理 System One 格式，并使用该 provider 的凭据。

模型目录里没有这个分类器时，结果是 `missing-classifier`。适配器失败时，结果是 `error`。没有可复用的上一规划模型时，初始化选择 `models.standard`。之后的失败保持当前模型。这两种结果都不允许守卫式交接。

更换分类器、模型或 `classifier.temperature` 之后，重新设置 `threshold`。这三项都会改变概率刻度。

### Adaptive 字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`，或用 `first-write` 保留更早的交接规则 |
| `adaptive.handoffThreshold` | `0.2` | 仍允许守卫式交接的最高 complex 概率。范围从 0 到 1 |
| `adaptive.maxHandoffContextTokens` | `50000` | 仍允许守卫式交接的最大上下文估算。从 1 到最大安全整数的整数 |
| `adaptive.handoffTools` | `edit`、`write` | 成功后能在 `adaptive` 下触发交接的工具名 |
| `adaptive.downgradeThreshold` | `0.15` | complex 概率不高于此值时可降级，必须低于 `threshold` |
| `adaptive.minDwellTurns` | `2` | complex 降级前需评估的用户轮数，整数 1 到 20 |
| `adaptive.historyMaxTurns` | `4` | 要保留的更早完整轮数。从 1 到 8 的整数 |
| `adaptive.historyCharLimit` | `8000` | 历史文本上限，单位是 UTF-16 code unit。从 1 到 32000 的整数 |

交接字段作用于 `adaptive`。`fixed` 和 `shadow` 把成功的 `edit` 或 `write` 当作写入，包括成功的嵌套调用。

空的 `adaptive.handoffTools` 数组会关闭 adaptive 交接。`bash` 和 `codemode` 会被拒绝。包装工具成功不算写入。自定义名称只有在该工具的成功表示一次写入时才有效。

`strategy`、`adaptive` 和 `diagnostics` 拒绝 `null` 和其他非法值。`classifier.temperature` 和 `classifier.timeoutMs` 也拒绝 `null`。`models.implementation`、`models.direct` 和 `classifier` 仍然接受 `null` 或 `false`。

### 虚拟模型与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `virtual.provider` | `jev` | 虚拟模型显示在哪个 provider 下 |
| `virtual.id` | `auto` | 模型 id。默认选择是 `jev/auto` |
| `virtual.name` | `Auto (Jev)` | `/model` 里显示的名称 |
| `virtual.thinkingLevels` | `low`、`medium`、`high`、`xhigh`、`max` | 虚拟模型提供的思考强度 |
| `virtual.contextWindow` | `272000` | 第一次被路由的响应之前显示的上下文窗口 |
| `virtual.maxTokens` | `128000` | 第一次被路由的响应之前显示的最大输出 |
| `diagnostics.record` | `false` | 保存脱敏后的决策条目和主请求的 outcome 条目 |
| `debug` | `false` | 把路由元数据写到 stderr。`JEV_ROUTER_DEBUG=1` 打开同一份日志 |

第一次路由之后，虚拟模型显示被路由模型的上下文窗口和最大输出。

## 路由

### 初始选择

初始化时，路由复用可用的上一规划模型。没有可用的规划模型时，路由对当前原生用户条目分类一次。

原生用户条目是投影里最后一条原始角色为 `user` 的来源。分类器读取该条目投影后的可见文本。转换后的自定义消息、摘要或 bash 输出不会替换这个来源。该条目可以来自 SDK 或其他扩展。`user` 角色并不表示文本是人输入的。只存在于单次请求的变换不会替换已保存的投影。

概率达到或超过 `threshold` 时，选择 `models.complex`。更低的概率选择 `models.standard`。分类不可用时，初始化选择 `models.standard`。之后的失败保持当前模型。

### 交接与升级

守卫式 adaptive 交接需要同时满足下面各项：

- 决策后的槽位是 `models.standard`。complex 概率有效，低于 `threshold`，并且不超过 `adaptive.handoffThreshold`。复用的规划模型没有已保存的概率。守卫式交接需要这份概率。
- 当前原生投影文本非空，在 `promptLimit` 以内，并且没有图片。分类器输入仍与决策时使用的输入一致。状态保存该输入的 SHA-256 摘要。
- `adaptive.handoffTools` 里的一次成功调用，出现在当前原生用户条目和 `stageStartEntryId` 之后。
- 上下文 token 估算是有限数，大于或等于 0，并且不超过 `adaptive.maxHandoffContextTokens`。
- `models.implementation` 仍在模型目录中。

选中 complex 会锁定交接。分类被关闭、分类器缺失、回答无效、报错或超时，都不允许守卫式交接。新的用户边界会替换之前的交接证据。

每个新的原生用户条目评估一次，complex 槽位也会评估。概率达到 `threshold` 时，非 complex 槽位升级。概率不高于 `adaptive.downgradeThreshold`、当前输入完整且 complex 中已评估至少 `adaptive.minDwellTurns` 个用户轮次时，complex 降级到 standard。输入不完整时不降级，分类不可用时保持当前模型。槽位改变时驻留计数归零。同一分支可以多次升级和交接。

每个新压缩条目在下次 user 或 continuation 请求时评估一次。压缩不增加驻留计数。新用户与压缩同时出现时只评估一次。重试不消费待处理的压缩。重新启用交接会设置新的写入边界，旧写入不会触发交接。

要保留更早的 first-write 规则，在配置里设置这个策略：

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` 允许 standard 在分类不可用时交接。它跳过文本检查和上下文 token 上限。complex 仍锁定交接。

状态为 `ok` 的嵌套调用，在外层工具后来失败或记录不完整时仍然算数。这次调用表明写入已经完成。它不表明整个任务已经完成。失败或未完成的嵌套调用不算。工具参数不算。正文里说文件已经写好，不算。成功的包装工具不算。

这次检查使用当前分支上的条目 id。`stageStartEntryId` 之前的写入，或当前原生用户条目之前的写入，不会开始这次交接。没有嵌套工具记录时，Pi 能识别成功的外层写入，不能识别嵌套写入。

### 重试、取消与期限

重试不分类，也不交接。失败模型仍可用，并且属于已配置的 provider 时，重试保留该模型。失败模型的 id 必须匹配某个已配置的模型 id，或状态里已经保存的 id。重试保留该模型的思考强度。这些检查失败时，重试使用有效状态、可用的上一规划模型，或 `models.standard`。

重试最终选中的模型与有效状态模型相同时保留交接状态，包括回退到该模型的情况；切换到不同模型时锁定交接。重复重试不会再追加一份相同的状态。Pi 在发送主请求之前保存返回的状态。之后的模型失败不会撤销这份已保存的状态。

`adaptive.decisionTimeoutMs` 是本地期限。该期限适用于每种策略。设置了 `classifier.timeoutMs` 时，分类器调用使用这个值。期限先到时，更晚的成功或失败都会被忽略。调用方取消或服务中止会停止路由，并且不返回候选状态。直接请求跳过分类和已保存的状态。取消仍会停止该请求。

### 状态与迁移

Adaptive 状态使用 `schemaVersion` 1 和 `policyVersion` `"adaptive-v3"`。更早的 phase 和 model 状态、`adaptive-v1`、`adaptive-v2` 迁移时锁定交接，并将已有压缩标记为已处理。

配置变化、provider 变化，或丢失 `stageStartEntryId`，都会结束之前的交接。非法的 adaptive 状态会失败，错误文本是 `invalid adaptive state; start a new session or switch strategy to fixed`。

`fixed` 可以读取 adaptive 的 phase 和 model 状态。把 `strategy` 设为 `fixed` 会恢复 fixed 的交接。Fixed 状态记录 provider、交接锁和 `stageStartEntryId`。状态跟随恢复、压缩和分支祖先。新会话开始时没有已保存的路由状态。

## Shadow 模式

`shadow` 使用 `fixed` 的路由，并对初始提示分类。之后的原生用户条目上，槽位不是 `models.complex` 时，`shadow` 读取 adaptive 的输入。然后 `shadow` 保持当前模型，或指出一次升级。

stderr 包含 `proposedModel`、`available`，以及值为 false 的 `applied`。`debug` 关闭时也会打印这一行。`debug` 打开时，调试日志包含同一条决策。`shadow` 保持 `fixed` 的模型。日志中的模型是 `shadow` 本来会选中的升级目标。这些字段没有质量分数，也没有成本差额。

最后评估的条目 id 会被保存，因此重新打开后不会再对该条目分类。重试不执行 shadow 分类。continuation 不执行 shadow 分类。

## 诊断

把 `diagnostics.record` 设为 true，用来保存条目。

`pi-jev-router.decision` 条目包含 `decisionReason`、源模型、目标模型和请求的思考强度。它还包含 `classifierStatus`、`classifierApi`、概率、耗时、安全用量和上下文估算。

随机的 `decisionId` 把该条目关联到最终主助手响应的 `pi-jev-router.outcome` 条目。outcome 包含实际思考强度、停止原因、失败类别、上报的用量，以及路由之后经过的时间。

缺失的 outcome 保持缺失。outcome 不是 HTTP 日志，也不记录到达首个 token 的时间。直接请求不写这两类条目。

路由在写入 outcome 之前检查会话和分支祖先。它在会话边界和 agent 边界清除未完成的关联。期限之后到达的分类器结果会被忽略。会话、分支或输入已经不是发起该调用时的那一个时，结果也会被忽略。

决策条目和分类记录省略提示词、代码、工具参数、响应正文、凭据和原始错误。写入失败时打印 `diagnostics-unavailable`，路由保持不变。这次失败可能让用量不完整，或停在 pending。

诊断不进入模型上下文。它们不是另一份计费用量。主助手 outcome 的用量已经在 Pi 的会话总计里。

### `/jev-router` 命令

所有子命令都挂在一个命名空间下：

| 命令 | 范围 |
| --- | --- |
| `/jev-router status` | 启动时加载的配置：策略、模型、分类器、诊断、debug，以及 pi 实际读到的配置文件 |
| `/jev-router usage` | 当前分支 |
| `/jev-router usage --session` | 当前会话文件里的全部条目，包括放弃的分支 |
| `/jev-router usage --json` | 同一份摘要，以 JSON 输出 |
| `/jev-router help` | 这份列表。裸 `/jev-router` 也会打印它 |

`/jev-usage` 已移除，改用 `/jev-router usage`，`--session` 和 `--json` 参数不变。Pi 会把无法识别的斜杠命令当作普通消息发送，所以旧写法不会报错，而是变成一次模型请求：习惯和脚本都要改过来。

`status` 和 `usage` 都不调用模型，也不改变状态。`status` 报告的是启动时加载的配置，不是实时路由，也不代表某个模型或分类器可用；它会列出 pi 实际读到的配置文件，少了文件或多了意外文件都能看出来。改完配置文件需要重启 Pi。两个子命令在没有 UI 的宿主上也会写入 `stdout`。

usage 查询返回的摘要与 `summarizeClassifierUsage(manager, virtual, scope)` 相同。`virtual` 的默认 provider 是 `jev`，默认 id 是 `auto`。`scope` 默认是 `branch`。`apis` 字段列出这些尝试里记录到的分类器适配器。

每次分类尝试都有一个随机 call id、一份 pending 快照和一份 terminal 快照。快照只计算一次。取消之后的一次真实重试另计一次。摘要只计算本版本记录的尝试。

上报的 token 不是账单。缺失用量、pending 调用，以及未知或为零的目录价格，仍会显示出来。只要有一项成本未知，`knownCost` 就是已知成本的小计。超时或已取消的调用仍可能产生摘要里没有的服务用量。

重新打开和压缩会保留用量条目。分支查询沿着祖先查找。会话查询包含放弃的分支。fork 包含祖先的用量。把父级总计和 fork 总计相加，会把共有用量计算两次。

在 Pi 1.2.0 的在线检查中，直接分类器用量不在 `/session` 里。升级 Pi 之后，在合并总计之前，再次对照宿主记账和 `/jev-usage`。主助手 outcome 记录已经在 Pi 的会话记账里。

### 思考强度

被路由的模型是实际运行该请求的目录模型。派发时先读虚拟模型在 `settings.modelThinkingLevels` 里的项，再读被路由模型的项，然后使用请求里的思考强度。保留失败模型的重试，会在这些键之前使用 `failed.thinkingLevel`。Pi 把强度钳制到被路由模型允许的范围。键的例子有 `openai-codex/gpt-6-astra` 和 `jev/auto`。

## 隐私

默认情况下，分类器输入是最后一条原生用户条目的投影可见文本。转换后的自定义消息、摘要或 bash 输出不会替换这个来源。图片、思考和工具数据会被排除。

`fixed` 和最初的 `shadow` 分类发送 `state.prompt` 负载。`adaptive` 发送 `state.current`。没有来源条目，或投影文本为空时，路由不调用分类器。

Adaptive 分类和之后的 shadow 检查始终在当前用户文本之外包含 `state.recentTurns` 与 `state.historyPartial`。已移除的 `adaptive.contextMode` 会告警并忽略。Fixed 和最初的 shadow 分类不变。

上一轮包含原生用户文本和成功的助手文本，按时间顺序排列。`stopReason` 为 `stop` 或 `toolUse` 时，助手文本计入。历史会省略工具、思考、图片、system 消息、custom 消息、摘要，以及失败或中止的响应。

最新的完整轮次必须同时满足 `adaptive.historyMaxTurns` 和 `adaptive.historyCharLimit`。路由丢掉最旧的整轮，直到历史能放下。如果只有最新一轮就超过某个预算，历史为空。路由不会用更早的一轮替换这一轮。

当前文本使用 `promptLimit`，与历史预算分开。这些预算不包含分类器指令和 JSON 开销。路由不调用摘要模型来缩短历史。

路由读取压缩和上下文编辑留下的文本。`historyPartial` 表示历史不完整。这个标志不报告分类器概率。

用户文本和助手文本可能含有粘贴进来的密钥或文件内容。过滤不会去掉这些密钥。把 `classifier` 设为 `null` 或 `false`，可停止全部分类器请求。

## 故障排查

- `/model` 里没有 `jev/auto`，是因为包没有加载、Pi 还没有重启，或 checkout 和 npm 包一起加载了。只安装一份，然后重启 Pi。
- 配置的模型不在 `pi --list-models` 里，是因为 `provider` 或 `models` 和模型目录不一致。把这些字段设成该命令打印出的 id。
- 分类失败或超时。没有可复用的上一规划模型时，初始化改用 `models.standard`。之后的失败保持当前模型。把 `classifier` 设为 `null` 可关闭分类。`missing-classifier` 表示模型目录里没有该 provider 和 id 的 `classifier` 模型。`error` 表示适配器请求失败。原因包括缺少凭据、端点不可达和服务器错误。使用 `llama.cpp` 时，先提高 `classifier.timeoutMs`，再把路由当作故障。
- 文件修改在下一次 Pi 启动时生效。Pi 按[配置文件](#配置文件)一节的来源读取。未知键会打印警告。
- Pi 没有嵌套工具记录，并且成功的写入不是外层工具结果时，这次写入会被忽略。

## 开发

运行路由和生命周期测试：

```sh
npm test
```

包含公开的 `SessionManager` 用例：

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

没有 `PI_ROUTER_HOST_MODULE` 时，宿主用例会跳过，并说明自己跳过了。[`plans/003-final-router.md`](plans/003-final-router.md) 里的记录是 27 个套件、232 项测试通过。那次运行包含真实的 `SessionManager` 用例，以及针对已安装的 Pi 和 pi-ai 类型声明所做的严格 `tsc --noEmit` 检查。

测试使用固定的分类器和模型目录 fixture。它们检查路由和会话生命周期。它们不测量分类准确率、生产延迟、任务质量或费用。适配器测试通过注册表 mock 提供归一化结果。真实登录和线上协议不在这些测试里。

`scripts/live-agent-smoke.ts` 会向已配置的账户计费。该脚本不属于 `npm test`。它使用已配置的 `codex-sub2api` sol 和 luna 模型以及 `typesafe/jev-latest`，在临时目录里运行。`core` 场景只有在真实分类器达到守卫式交接阈值时才算验证通过。一次没有发生交接的运行不会验证该场景。本版本没有重跑 live 场景。

先审阅 `scripts/live-agent-smoke.ts`，再运行它：

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
```

其他场景名是 `core`、`cancel` 和 `retry`。

维护者的发布步骤在 [`RELEASING.md`](RELEASING.md)。

## 许可证

MIT。条款在 [`LICENSE`](LICENSE)。
