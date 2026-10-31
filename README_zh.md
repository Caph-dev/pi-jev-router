# pi-jev-router

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@caph42/pi-jev-router)](https://www.npmjs.com/package/@caph42/pi-jev-router)
[![license](https://img.shields.io/npm/l/@caph42/pi-jev-router)](LICENSE)

`pi-jev-router` 是 [pi](https://pi.dev) 的扩展。它注册一个虚拟模型 `jev/auto`，并为发到该模型的每个请求挑选一个物理模型。

目的是让强模型负责规划，让便宜的模型按规划干活。分类器只评估文本，不读取模型名和价格。

```text
agent 循环请求
├─ 一个新阶段的第一个请求      → 分类 → models.complex，否则 models.standard
└─ 一次符合条件的成功写入之后  → 允许交接时进入 models.implementation

直接请求（压缩、标题）
└─ models.direct → models.implementation → models.standard
```

三种策略决定路由器多久重新看一次输入。`adaptive` 是默认策略，在每个用户消息和每次压缩后重新判定。`fixed` 只分类一次，在第一次成功写入后换成实现模型，并把它用到分支结束。`shadow` 记录分类器本会触发的升级但不改变路由。

## 安装

```sh
pi install npm:@caph42/pi-jev-router
```

在包名后加 `@<version>` 可以锁定某个版本。不安装、直接加载本地检出：

```sh
pi -e ./extensions/jev-router.ts --model jev/auto
```

然后在 `/model` 里选择 **Auto (Jev)**，或者用 `pi --model jev/auto` 启动 pi。

升级用 `pi update --extensions`。本地检出和 npm 包只加载一个，两个同时加载会注册两次 `jev/auto`。安装包本身不会改动已有的 `jev-router.json`，但之后的第一次启动可能会，见[更新之后](#更新之后)。

### 环境要求

- pi 需要提供虚拟模型、持久分支 id 和 `buildSessionProjection()`。本仓库的测试套件在 pi 1.4.0 上通过，命令见[开发](#开发)。
- 每个配置的模型都应该能在 `pi --list-models` 里按 `provider` 找到。默认是 `openai-codex` 的三个模型：复杂任务用 `gpt-6-astra`，其余用 `gpt-6.1-sol`，实现阶段用 `gpt-6-luna`。
- 分类器不是必需的。它必须是一个 pi 类型为 `classifier` 的模型，默认 `typesafe/jev-latest`；适配器见[分类器端点](#分类器端点)。把 `classifier` 设为 `null` 或 `false` 可以关闭分类。在默认的 `adaptive` 策略下，升级和守卫式交接依赖分类器。
- Node 20 或更新，与 `engines` 字段一致。本版本的测试跑在 Node 24.15.0 上。

宿主没有 `buildSessionProjection()` 时，`fixed` 和 `shadow` 不发送分类输入，也检测不到写入。它们仍会用 `models.standard` 起步，或复用之前的规划模型。默认的 `adaptive` 会调用投影接口，缺少该接口时直接报错。

### 更新之后

路由器在 pi agent 目录（设置了 `PI_CODING_AGENT_DIR` 时就是该目录）下保留 `jev-router-state.json`，把上次运行的版本记在里面。这个文件是状态，不是配置。

新版本的第一次启动，包括全新安装，会做一次下面两件事：

- 优先级最高的那个把 `strategy` 设成 `adaptive` 以外的值的配置文件会被改成 `adaptive`，路由器打印改了哪个文件。只动这一个文件，当前进程不需要重启就按新值路由。
- 没有任何配置文件设置 `provider`、`models` 或 `classifier` 时，路由器打印该写哪个文件：个人的 `jev-router.json`，或 `$JEV_ROUTER_CONFIG` 指向的文件。这三项里设置任意一项就算已配置，提醒随之消失。

每次状态文件只尝试切换一次，无论有没有文件设置过 `strategy`。你之后把它设回 `fixed`，后续更新不会再动它。作用域是一个 agent 目录，所以在这个目录下第一个启动的项目就会用掉这次切换，同目录的其他项目共享这个结果。

宿主有 UI 时通知走界面，没有 UI 时写到 stdout。通知依赖宿主的 `session_start` 事件；没有该事件的宿主照常加载路由器，只是不发通知。

版本没变时什么都不打印。删掉 `jev-router-state.json`，下次启动会重跑这两步。

## 策略

规划阶段落在 `models.complex` 或 `models.standard` 上。分类之前，路由器会先复用可用的上一规划模型。

`adaptive` 是默认策略。它分类第一条用户消息，在选中的模型上规划，然后在每个新用户消息和每次压缩后重新判定。分类器有把握时升级到 `models.complex`；在复杂档停留够久后降级到 `models.standard`；新任务看起来便宜且守卫条件全部成立时，交接给 `models.implementation`。

`fixed` 只分类一次，并在本回合第一次成功 `edit` 或 `write` 之后交接给 `models.implementation`。之后的用户消息保持当前模型，所以分支余下的部分都跑在实现模型上。

`shadow` 的路由与 `fixed` 完全相同。它照样分类新的用户消息，并记录下本会做出的升级。

| 策略 | 首个请求 | 成功写入之后 | 之后的用户消息 |
| --- | --- | --- | --- |
| `fixed` | 分类一次，或复用可用的上一规划模型 | 交接给 `models.implementation` | 保持当前模型 |
| `adaptive`（默认） | 同样的选择。`handoffPolicy` 默认是 `guarded` | 守卫条件全部成立时交接 | 每个新用户消息和每次压缩后重新判定。符合条件时升级；降级受 `minDwellTurns` 限制；符合条件时重新启用交接 |
| `shadow` | 与 `fixed` 相同的路由 | 与 `fixed` 相同的路由 | 记录这次升级，保持 `fixed` 的模型 |

第一次分类不可用时，路由器选择 `models.standard`。之后的分类不可用时，路由器保持当前模型。

初始模型缺失、`models.direct` 指向的模型缺失、`models.standard` 缺失时，请求以配置错误失败。交接目标或升级目标缺失时保持当前模型。状态里保存的模型已经不在目录中时，替换为 `models.standard`，恢复出来的这份状态会锁定交接。

分类调用发送投影后的文本，`maxRetries` 为 0，并在本地期限处停止。符合条件时重试留在失败的模型上，条件见[重试](#重试)。取消会中止路由，并返回空的状态。直接请求跳过分类和已保存状态，取消同样会中止它。

## 配置

当 OpenAI Codex 登录能看到默认模型时，默认的 `adaptive` 策略不需要配置文件。下面的文件打开诊断：

```json
{
  "diagnostics": { "record": true }
}
```

Codex 登录覆盖默认模型，默认分类器需要 TypeSafe 凭据。没有可用的分类器时，`adaptive` 对当前输入没有概率值。它复用可用的规划模型或以 `models.standard` 起步，守卫式交接不启用，升级也不启用。没有分类器也想用上 `models.implementation` 的话，设 `"adaptive": { "handoffPolicy": "first-write" }`，或换回 `"strategy": "fixed"`。

pi 在启动时读取配置，改完要重启 pi。[`jev-router.example.json`](jev-router.example.json) 列出了所有内置默认值。

### 配置文件

pi 读取下表中的文件。

| 来源 | 范围 |
| --- | --- |
| `$JEV_ROUTER_CONFIG` | 只读该文件，不再读其他配置文件 |
| `~/.pi/agent/jev-router.json` | 个人文件。设置了 `PI_CODING_AGENT_DIR` 时，个人文件是 `$PI_CODING_AGENT_DIR/jev-router.json` |
| `<项目>/.pi/jev-router.json` | 项目文件，合并覆盖个人文件 |

嵌套对象逐项合并。后读文件里的数组整体替换前面的数组。文件不存在不算错误，格式错误会让启动失败，未知字段只打印警告并被忽略。

### 路由字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `strategy` | `adaptive` | `adaptive`（默认）、`fixed` 或 `shadow` |
| `provider` | `openai-codex` | 存放各槽位模型的 provider |
| `models.complex` | `gpt-6-astra` | 分类器判定为复杂时的规划模型 |
| `models.standard` | `gpt-6.1-sol` | 其余情况的规划模型，也是第一次分类不可用时的兜底 |
| `models.implementation` | `gpt-6-luna` | 交接之后的模型。`null` 或 `false` 关闭交接 |
| `models.direct` | `null` | 直接请求用的模型。`null` 时先用 `models.implementation`，再用 `models.standard` |
| `classifier.provider` | `typesafe` | 分类器 provider。`classifier` 设为 `null` 或 `false` 关闭分类 |
| `classifier.id` | `jev-latest` | 分类器模型 id |
| `classifier.temperature` | 未设置 | 归一化之前用于除标签 logits 的系数，大于 0 且不超过 100 |
| `classifier.timeoutMs` | 未设置 | 单次分类调用期限，1 到 60000 的整数。这一次调用替代 `adaptive.decisionTimeoutMs` |
| `threshold` | `0.5` | 概率达到该值即选中 `models.complex`，范围 0 到 1 |
| `promptLimit` | `16000` | 当前文本上限，单位是 UTF-16 code unit，范围 1 到 1000000 |
| `adaptive.decisionTimeoutMs` | `3000` | 分类的本地期限，1 到 60000 的整数，对所有策略生效 |

`classifier.temperature` 只被按标签概率排序的适配器读取，其他适配器忽略它。不写 `classifier.temperature` 或 `classifier.timeoutMs` 时沿用继承值。

期限字段沿用 `adaptive.decisionTimeoutMs` 这个名字，是为了让旧配置文件继续可解析。3000 毫秒是兼容默认值。

### 分类器端点

`classifier.provider` 和 `classifier.id` 指向一个 pi 类型为 `classifier` 的模型。路由器不解析端点 URL，目录里的条目决定用哪个适配器。

| API | 示例模型 | 凭据 | 说明 |
| --- | --- | --- | --- |
| `typesafe-system-one` | `typesafe/jev-latest` | `TYPESAFE_API_KEY` | 默认。该模型在目录里没有价格，所以 `/jev-router usage` 把它的费用报为未知 |
| `cloudflare-workers-ai-system-one` | `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` 和 `CLOUDFLARE_ACCOUNT_ID` | Workers AI 上的 Jev 模型也用这个适配器 |
| `llama-cpp-classify` | `llama.cpp` 路由器上的一个 chat 模型 | pi 的 `/login llama.cpp` 连接，服务端 API key 可选 | 需要 llama.cpp 的 `/tokenize`、`/apply-template` 和 `/completion` |
| `openai-decisions` | `openai/gpt-6-luna` | `OPENAI_API_KEY` | `/login` 的 ChatGPT 登录不提供这个 key。用 key 之前先退出 `openai` provider |

`llama-cpp-classify` 会把分类状态渲染两次。`classifier.timeoutMs` 要留够分词、套模板和读取概率的时间。llama.cpp 给出的原始标签概率通常过于自信，大于 1 的 `classifier.temperature` 会在归一化前除 logits，把接近 0 或 1 的概率往中间拉。

`openrouter`、`vercel-ai-gateway` 和 `opencode` 上的模型代理 System One 格式，并使用各自 provider 的凭据。

目录里找不到分类器时结果是 `missing-classifier`，适配器调用失败时结果是 `error`。没有可复用的上一规划模型时，初始阶段选择 `models.standard`；之后的失败保持当前模型。这两种结果都不允许守卫式交接。

改过分类器、模型或 `classifier.temperature` 之后要重新设置 `threshold`，因为它们都会改变概率的尺度。

### Adaptive 字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `adaptive.handoffPolicy` | `guarded` | `guarded`，或使用旧规则的 `first-write` |
| `adaptive.handoffThreshold` | `0.2` | 仍允许守卫式交接的最高 complex 概率，范围 0 到 1 |
| `adaptive.maxHandoffContextTokens` | `50000` | 仍允许守卫式交接的最大上下文估算，1 到最大安全整数的整数 |
| `adaptive.handoffTools` | `edit`、`write` | `adaptive` 下成功后可交接的工具名 |
| `adaptive.downgradeThreshold` | `0.15` | complex 概率不高于此值时可降级，必须小于 `threshold` |
| `adaptive.minDwellTurns` | `2` | complex 降级前需评估的用户轮数，1 到 20 |
| `adaptive.historyMaxTurns` | `4` | 保留的较早完整轮数，1 到 8 的整数 |
| `adaptive.historyCharLimit` | `8000` | 历史文本上限，单位是 UTF-16 code unit，1 到 32000 的整数 |

交接相关字段只对 `adaptive` 生效。`fixed` 和 `shadow` 把一次成功的 `edit` 或 `write` 视为写入，包括成功的嵌套调用。

`adaptive.handoffTools` 设为空数组会关闭 adaptive 交接。`bash` 和 `codemode` 会被拒绝。成功的包装工具不算写入；自定义工具名有效的前提是该工具成功就代表工作进入了实现阶段。

### 虚拟模型与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `virtual.provider` | `jev` | 虚拟模型展示时使用的 provider |
| `virtual.id` | `auto` | 模型 id，默认选中 `jev/auto` |
| `virtual.name` | `Auto (Jev)` | `/model` 里显示的名字 |
| `virtual.thinkingLevels` | `low`、`medium`、`high`、`xhigh`、`max` | 虚拟模型提供的思考强度 |
| `virtual.contextWindow` | `272000` | 第一个路由响应之前展示的上下文窗口 |
| `virtual.maxTokens` | `128000` | 第一个路由响应之前展示的最大输出 |
| `diagnostics.record` | `false` | 保存脱敏后的决策条目和主请求结果条目 |
| `debug` | `false` | 把路由元数据写到 stderr。`JEV_ROUTER_DEBUG=1` 打开同一份日志 |

第一次路由之后，虚拟模型展示的是被路由模型的上下文窗口和最大输出。

`strategy`、`adaptive` 和 `diagnostics` 拒绝 `null` 及其他非法值。`classifier.temperature` 和 `classifier.timeoutMs` 同样拒绝 `null`。`models.implementation`、`models.direct` 和 `classifier` 接受 `null` 或 `false`。

## 路由决策

### 第一个请求

初始化时，路由器先复用可用的上一规划模型。没有可用的规划模型时，它把当前原生用户条目分类一次。

原生用户条目是原始角色为 `user` 的最后一个投影来源。分类器读取该条目投影后的可见文本。转换过的自定义消息、摘要或 bash 输出都不会替换这个来源。该条目可能来自 SDK 或另一个扩展，所以角色是 `user` 不代表有人手打过这段文字。只对单个请求生效的变换不会替换已保存的投影。

概率达到 `threshold` 选中 `models.complex`，更低则选中 `models.standard`。分类不可用时，初始化选择 `models.standard`；之后的失败保持当前模型。

### 交接给实现模型

守卫式 adaptive 交接需要同时满足下面各项。

- 判定后的槽位是 `models.standard`。complex 概率有效，低于 `threshold`，并且不超过 `adaptive.handoffThreshold`。复用的规划模型没有保存概率，而守卫式交接需要这份概率。
- 当前原生投影文本非空，在 `promptLimit` 以内，并且不含图片。分类器输入仍与决策时使用的输入一致，状态里以 SHA-256 摘要记录这份输入。
- `adaptive.handoffTools` 里的一次成功调用出现在当前原生用户条目和 `stageStartEntryId` 之后。
- 上下文 token 估算是有限数，大于或等于 0，并且不超过 `adaptive.maxHandoffContextTokens`。
- `models.implementation` 仍在模型目录中。

选中 complex 会锁定交接。分类被关闭、分类器缺失、回答无效、报错或超时，都不允许守卫式交接。新的用户边界会替换之前的交接证据。

状态为 `ok` 的嵌套调用，即使外层工具随后失败或记录不完整，也算数。这次调用说明写入已经完成，不说明整个任务已经完成。失败或未完成的嵌套调用不算。工具参数不算，正文里写文件已写好不算，成功的包装工具也不算。

这项检查使用当前分支上的条目 id。发生在 `stageStartEntryId` 之前、或当前原生用户条目之前的写入，不会触发这次交接。宿主没有嵌套工具记录时，pi 能识别外层工具的成功写入，识别不到嵌套写入。

### 升级与降级

每个新的原生用户条目评估一次，complex 槽位也一样。概率达到 `threshold` 时，非 complex 槽位升级。complex 在概率不高于 `adaptive.downgradeThreshold`、当前输入完整、且槽位内已评估至少 `adaptive.minDwellTurns` 个用户轮次时降级到 standard。输入不完整时不降级，分类不可用时保持当前模型。槽位变化会把驻留计数归零，同一分支可以多次升级和交接。

每个新压缩条目也会触发一次评估，发生在下一个 user 或 continuation 请求上。压缩不增加驻留计数。新用户消息和压缩同时出现时只评估一次，重试不会消费待处理的压缩。重新启用交接会设置新的写入边界，更早的写入无法触发它。

要保留更早的 first-write 规则，在配置里设置：

```json
{ "strategy": "adaptive", "adaptive": { "handoffPolicy": "first-write" } }
```

`first-write` 允许 standard 在分类不可用时交接。它跳过文本检查和上下文 token 上限。complex 仍锁定交接。

### 重试

重试不分类，也不交接。失败模型仍在已配置的 provider 上可用，而且失败 id 匹配某个已配置模型 id 或状态里已保存的 id 时，重试留在该模型上。它同时保留该模型的思考强度。这些检查不通过时，重试使用有效状态、可用的上一规划模型，或 `models.standard`。

重试最终选中的模型与有效状态模型相同时保留交接状态，包括回退到该模型的情况。落到不同模型上的重试会锁定交接。重复重试不会追加第二份相同状态。pi 在发送主请求之前保存返回的状态，之后的模型失败不会撤销这份状态。

### 期限与取消

`adaptive.decisionTimeoutMs` 是本地期限，对所有策略生效。设置了 `classifier.timeoutMs` 时，分类调用改用该值。期限先到时，之后到达的成功或失败结果都被忽略。

调用方取消或服务中断会中止路由，并返回空的状态。直接请求跳过分类和已保存状态，取消同样会中止它。

### 保存的状态与迁移

Adaptive 状态使用 `schemaVersion` 1 和 `policyVersion` `"adaptive-v3"`。更早的阶段与模型状态、`adaptive-v1` 和 `adaptive-v2` 在迁移时锁定交接，已有的压缩在迁移中标为已处理。

配置变化、provider 变化或 `stageStartEntryId` 丢失会结束之前的交接。Adaptive 状态非法时报错 `invalid adaptive state; start a new session or switch strategy to fixed`。

`fixed` 能读取 adaptive 的阶段与模型状态。把 `strategy` 设为 `fixed` 会恢复 fixed 交接。Fixed 状态记录 provider、交接锁和 `stageStartEntryId`。状态跟随 resume、压缩和分支继承，新会话不带保存的路由状态。

## Shadow 模式

`shadow` 使用 `fixed` 的路由，并分类初始输入。之后的原生用户条目上，只要槽位不是 `models.complex`，`shadow` 就读取 `adaptive` 会用的那份输入，然后保持当前模型或给出一个升级建议。

`debug` 关闭时，stderr 上打印一行，包含 `proposedModel`、`available` 和恒为 false 的 `applied`。`debug` 打开时，同一份决策写进调试日志。`shadow` 保持 `fixed` 的模型，日志里的模型是它本会选中的升级目标。这些字段不含质量评分，也不含费用差额。

最后评估过的条目 id 会被保存，重新打开会话不会重复分类该条目。重试和 continuation 不运行 shadow 分类。

## `/jev-router` 命令

所有子命令都通过这一个带命名空间的命令访问。

| 命令 | 范围 |
| --- | --- |
| `/jev-router status` | 启动时加载的配置：策略、模型、分类器、诊断、debug，以及 pi 读过的配置文件 |
| `/jev-router usage` | 当前分支 |
| `/jev-router usage --session` | 当前会话文件里的所有条目，包括已放弃的分支 |
| `/jev-router usage --json` | 同一份汇总的 JSON 形式 |
| `/jev-router help` | 这份列表。只输入 `/jev-router` 也会打印 |

`/jev-usage` 已移除，改用 `/jev-router usage`，`--session` 和 `--json` 参数不变。pi 把未知斜杠命令当作普通消息，所以旧拼写会被发给模型而不是报错，留着旧名字的脚本要改。

`status` 和 `usage` 都不调用模型，也不改变状态。`status` 报告启动时加载的配置，不报告实时路由状态，也不报告模型或分类器是否可用。它会列出 pi 实际读到的配置文件，缺文件或读到意料外的文件都能看见。改完配置文件要重启 pi。这两个子命令在没有 UI 的宿主上写 stdout，同样可用。

用量查询返回的汇总与 `summarizeClassifierUsage(manager, virtual, scope)` 相同。`virtual` 默认是 provider `jev`、id `auto`，`scope` 默认是 `branch`。`apis` 字段列出这些调用记录到的分类器适配器。

每次分类调用都有随机调用 id、一份 pending 快照和一份终态快照。一份快照只计一次，取消之后真正的重试算一次独立调用。汇总只统计本版本记录到的调用。

上报的 token 不是账单。缺失用量、未完成调用、未知或为零的目录价格都会显示出来。只要有费用未知，`knownCost` 就只是已知费用的小计。超时或已取消的调用仍可能在服务端产生用量，这部分不会出现在汇总里。

重新打开和压缩都会保留用量条目。分支查询沿继承链统计，会话查询包含已放弃的分支，fork 统计里包含祖先的用量。把父分支总计加到 fork 总计上会把共享用量算两次。

pi 1.2.0 上的 `/session` 只统计宿主自己的用量，所以直接请求的分类器用量落在它之外。升级 pi 之后，把宿主账目和 `/jev-router usage` 再对比一次，再决定是否合并总计。主助手的结果记录本来就在 pi 的会话账目里。

### 思考强度

实际执行请求的是目录里被路由到的那个模型。分发时依次读取 `settings.modelThinkingLevels` 里虚拟模型的键、被路由模型的键，最后用请求自带的强度。保留失败模型的重试使用 `failed.thinkingLevel`，优先于这些键。pi 会把强度夹到被路由模型支持的范围内。键的示例是 `openai-codex/gpt-6-astra` 和 `jev/auto`。

## 诊断

把 `diagnostics.record` 设为 true 才会保存条目。

一条 `pi-jev-router.decision` 条目包含 `decisionReason`、来源模型、目标模型和请求的思考强度，还包含 `classifierStatus`、`classifierApi`、概率、耗时、脱敏后的用量和上下文估算。

随机的 `decisionId` 把这条条目和最终主助手响应对应的 `pi-jev-router.outcome` 条目关联起来。结果条目包含实际思考强度、停止原因、失败分类、上报用量，以及路由之后经过的时间。

没有结果条目就保持没有。结果不是 HTTP 日志，不记录首 token 时间。直接请求两条都不写。

路由器写结果之前会检查会话和分支继承关系，并在会话边界和 agent 边界清空待处理关联。超过期限才到达的分类结果被忽略。会话、分支或输入已经不是发起调用时的那一份时，结果同样被忽略。

决策条目和分类记录都不含提示词、代码、工具参数、响应体、凭据和原始错误。写入失败时打印 `diagnostics-unavailable`，路由保持不变，用量因此可能不完整或停在 pending。

诊断不进入模型上下文，也不是第二个计费用量来源，主助手结果用量本来就在 pi 的会话总计里。

## 隐私

默认情况下，分类器输入是最后一个原生用户条目投影后的可见文本。转换过的自定义消息、摘要或 bash 输出都不会替换这个来源。图片、思考和工具数据被排除。

`fixed` 和首次 `shadow` 分类发送 `state.prompt`，`adaptive` 发送 `state.current`。找不到来源条目或投影文本为空时，路由器不调用分类器。

Adaptive 分类和之后的 shadow 检查总是在当前用户文本之外带上 `state.recentTurns` 和 `state.historyPartial`。已移除的 `adaptive.contextMode` 会被忽略并打印警告。Fixed 和首次 shadow 分类的行为不变。

一个历史轮次包含原生用户文本和成功的助手文本，按时间排序。助手文本在 `stopReason` 为 `stop` 或 `toolUse` 时计入。历史里不含工具、思考、图片、系统消息、自定义消息、摘要，以及失败或中止的响应。

最新的几个完整轮次要同时满足 `adaptive.historyMaxTurns` 和 `adaptive.historyCharLimit`。路由器整轮丢弃最旧的轮次直到装得下。最新一轮单独就超出预算时，历史为空，路由器不会用更旧的轮次替代它。

当前文本用 `promptLimit`，与历史预算分开计算。这些预算不含分类器指令和 JSON 开销。路由器不会调用摘要模型来压缩历史。

分类读取的是压缩和上下文编辑之后留在投影里的文本。历史不完整时路由器设置 `historyPartial`，这个标记不反映分类概率。

用户文本和助手文本里可能贴着密钥或文件内容，过滤器不会移除它们。把 `classifier` 设为 `null` 或 `false` 可以停止所有分类请求。

## 故障排查

- `/model` 里没有 `jev/auto`：包没加载、pi 没重启，或者本地检出和 npm 包同时加载了。只装一份，然后重启 pi。
- 配置的模型在 `pi --list-models` 里找不到：`provider` 或 `models` 与目录不一致。把字段改成该命令输出的 id。
- 分类失败或超时：没有可复用的上一规划模型时，初始化改用 `models.standard`；之后的失败保持当前模型。把 `classifier` 设为 `null` 可以关闭分类。
- `missing-classifier` 表示目录里没有该 provider 和 id 的分类器模型。`error` 表示适配器请求失败，原因可能是缺凭据、端点不可达或服务端报错。用 `llama.cpp` 时先调大 `classifier.timeoutMs`，再判断路由是否出问题。
- 改配置后要到下次启动 pi 才生效，因为 pi 读取的是[配置文件](#配置文件)里列出的来源。未知字段会打印警告。
- 宿主没有嵌套工具记录，而成功写入不是外层工具的结果时，写入会被忽略。
- 分类不可用时，`adaptive` 不升级，也不做守卫式交接。没有可复用的规划模型时，它从 `models.standard` 起步。配置分类器、改成 `"handoffPolicy": "first-write"`，或切到 `fixed`。

## 开发

运行路由与生命周期测试：

```sh
npm test
```

带上公开的 `SessionManager` 用例：

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

不设置 `PI_ROUTER_HOST_MODULE` 时宿主用例会跳过并说明原因。在 pi 1.4.0 和 Node 24.15.0 上，套件总共报告 32 个套件、309 个测试。不带宿主模块时 301 个通过、8 个跳过，带上时 309 个全部通过。

测试使用固定的分类器与目录夹具，检查路由和会话生命周期。它们不衡量分类器准确率、生产时延、任务质量或费用。适配器测试通过注册表替身提供归一化结果，真实登录和线上协议不在这些测试范围内。

`scripts/live-agent-smoke.ts` 会产生真实费用。它不随 `npm test` 运行，使用配置好的 `codex-sub2api` sol 与 luna 模型和 `typesafe/jev-latest`，在临时目录里运行。只有在线分类结果达到守卫式交接阈值时，`core` 场景才算验证通过；从没触发交接的运行会让该场景保持未验证。本版本没有再跑在线场景。

先审阅 `scripts/live-agent-smoke.ts`，再运行：

```sh
PI_ROUTER_HOST_MODULE=/absolute/path/to/pi-coding-agent/dist/index.js \
  JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts fixed
```

其余场景名是 `core`、`cancel` 和 `retry`。维护者的发布步骤见 [`RELEASING.md`](RELEASING.md)。

## 许可证

MIT，条款见 [`LICENSE`](LICENSE)。
