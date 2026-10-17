# 计划 001 验收记录

日期：2026-10-16。规划基线：bb854b2e8f91b70dfc95a0a679966d37dd3348fa。

最新追加验收：P1 分类账与默认 fixed Codemode 支持已完成，真实宿主套件 171/171、四场景真实 LLM 共 10 项检查通过；细节见文末 P1 节。

下面保留计划 001 首轮历史证据。M1 与 M2 产品实现已完成，离线控制流和本机真实 SessionManager 已验收。
用户授权复用 codex-sub2api 后，真实主模型 agent loop smoke 已完成：core/cancel/retry 均通过，
共 8 项检查；core 最终退出码 0。当前本机验收门槛已满足，未执行发布。
不能把 SessionManager 手工构造记录或 route stub 描述为真实 Codemode/主模型调用证据。

## 环境与改动边界

- Node.js v24.15.0；pi @earendil-works/pi-coding-agent 1.2.0。
- 起始 git status 只有未跟踪的 plans/；产品代码相对规划基线无漂移。
- 基线 npm test：25 tests，25 pass，0 fail。
- 保留原有 25 项测试，未将失败测试改为 skip。
- 产品仍为 extensions/jev-router.ts 单文件；未新增运行时依赖。
- 修改范围：extensions/jev-router.ts、test/route.test.ts、test/config.test.ts、
  新增 test/host-session.test.ts、jev-router.example.json、README.md 和 plans/ 计划/验收文件。
- 追加在线测试授权范围：scripts/live-agent-smoke.ts、plans/live-smoke-results.json；未新增依赖。
- 未修改 package.json、锁文件、RELEASING.md、LICENSE、宿主源码、用户配置或凭据。
- plans/.html-cache/state.json 是本地渲染缓存，交付清单不包含它；它仍在未跟踪工作区中，没有通过 gitignore 自动排除，本轮未 stage。
- 仓库只有 test script；未运行或声称存在 lint/typecheck script。未 commit、push 或发布。

## 验证入口

配置与路由：

	npm test -- test/config.test.ts test/route.test.ts

结果：149 tests，149 pass，0 fail，0 skipped，exit 0。

默认完整套件：

	npm test

结果：153 tests，149 pass，0 fail，4 skipped。四项均明确提示配置 PI_ROUTER_HOST_MODULE。
默认套件不证明宿主专项已执行。

本机真实宿主专项：

	PI_ROUTER_HOST_MODULE=/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js npm test -- test/host-session.test.ts

结果：4 tests，4 pass，0 fail，0 skipped，exit 0。

完整套件包含真实宿主：

	PI_ROUTER_HOST_MODULE=/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js npm test

结果：153 tests，153 pass，0 fail，0 skipped，exit 0。

显式配置错误宿主路径：通过子进程运行测试，PI_ROUTER_HOST_MODULE 指向故意不存在的入口。
断言实际 exit 1 且输出 ERR_MODULE_NOT_FOUND，父检查 exit 0。没有将导入失败转为 skip。

	git diff --check

结果：exit 0，无输出。git diff --name-only 与 git status --short 包含上述范围内文件及既有 plans/。

## 步骤与行为证据

1. 固定基线：新增公开 route harness，模拟“返回的新 state 先保存，再执行主请求”。
   原引用和 undefined 不增加状态写入次数。fixed 表征阶段完整套件 35/35 通过。
2. M1 配置与状态：严格 strategy/adaptive 字段、普通对象、数组覆盖去重、禁用与非法值、
   personal/project 合并、未知键告警和 example 深比较通过。旧 phase/model 两阶段迁移锁定，
   非法状态和未知版本报错，旧宿主仅阻塞 adaptive。
3. 分类与升级：先观察未实现用例失败，再实现具名结果、调用预算和 caller 取消。
   implementation/standard → complex，simple/不可用保持，previous 不阻止新用户重判，
   同 ID 去重、同正文不同 ID 重判，目标缺失保持，均断言模型、阶段与分类次数。
4. 交接与恢复：nested ok、外层 error + nested ok、complete=false + ok 可交接；
   nested error/unfinished、成功 bash/codemode 外壳与正文声称不交接。
   旧 user、阶段锚点前写入不触发，新 user 重判优先，升级后 locked。
   retry failed 模型/强度优先、无状态 retry、provider/模型无效回退、已保存升级后失败均通过。
5. 决策记录与文档：结构化字段白名单、敏感正文/参数/服务错误哨兵排除、unknown 价格通过。
   README 中英文与 example 默认值一致；fixed 不消费 adaptive 策略，默认行为保留。
6. 有界历史：默认 current-only；显式 recent-conversation 才发送 recentTurns/historyPartial。
   历史按时间排列、整轮预算、UTF-16 计数、当前独立截断、超大最近轮禁止拼接更早小轮、
   思考/图片/工具/失败助手响应排除、投影替换与删除正文排除均通过。
7. 真实 SessionManager：T57–T60 专项零 skip；保存重开去重、不同 leaf/fork 状态隔离、
   compaction 保留路由 state 并裁剪分类输入、context edit 替换与删除正文均通过。

额外边界断言：同 ID 的 standard/complex 保留选中槽位，后续重判可只改 slot 而不增加阶段；
同 ID implementation → complex 改 phase；配置恢复和升级同次 route 只加一个 stageSeq。
变更 models、handoffTools、contextMode、provider 或 threshold 重建 locked 阶段；
virtual 展示变化不改变 configKey、不重复保存。迟到 success/rejection 不修改状态。
无状态初始化取消后同 user 可再次分类。

## 回归矩阵定位

- T01–T06：test/route.test.ts 的 fixed characterization、direct requests、missing models。
- T07–T12：adaptive classification 中两种升级起点、复杂后续接、simple、previous 与 ID 去重。
- T13–T19：adaptive classification 表驱动的 disabled/missing/error/throw/答案/概率/timeout，
  shared slot IDs and late classification 中已有状态 timeout 保持。
- T20–T24：五种 cancel 时机、初始取消重试、迟到结果与状态写入断言。
- T25–T31：handoff and branch boundaries 的九种工具结果及自定义/禁用交接。
- T32–T36：旧边界、初始化锚点前写入、新用户优先、锁定、丢失锚点、不重复持久化。
- T37–T42：retry and recovery 的 failed/无 failed/无状态/非法模型、thinking、limits 与失败保存。
- T43–T49：adaptive state normalization、retry and recovery、shared slot IDs、
  configuration and stage invariants，涵盖迁移、同 ID、目录缺失、配置/版本与 fixed 回退。
- T50–T56：provenance and history payload、M2 history configuration、UTF-16 预算断言。
- T57–T60：test/host-session.test.ts，对真实公共 SessionManager 操作后调用公开 route。

测试 ID 是覆盖类别，不以恰好 60 项计数作为完成条件。

## 真实分类连接检查

只输出凭据或环境变量是否存在，没有打印密钥、读取正文或修改凭据。
追加授权前的探测：默认个人存储中 typesafe/openai-codex/openrouter/openai/vercel-ai-gateway/cloudflare-workers-ai 均未发现凭据。
当前 TYPESAFE_API_KEY 存在。使用临时 auth/models 存储、禁用模型目录联网刷新：

	{"defaultMainConfigured":false,"classifierConfigured":true}

通过 pi ModelRuntime.classify 调用真实 typesafe/jev-latest，输入是合成的单函数变量重命名任务，
没有仓库正文、用户会话或工具结果。实际结果：

	{"onlineClassifierStopReason":"stop","probability":0,"durationMs":616,"usage":{"input":336,"output":33}}

这证明了一次分类连接可用，不是准确率、最优阈值、生产延迟或完整 agent loop 证据。
该临时调用未进入用户 session，没有可据此检查的 /session 账目。目录零报价不作为免费证据。

## 真实 agent loop smoke：passed

用户于 2026-10-16 追加授权复用当前 codex-sub2api 的 gpt-6-luna / gpt-6.1-sol。
原默认 openai-codex 缺认证的阻塞已被这项授权解除，默认产品配置没有更改。

脚本：scripts/live-agent-smoke.ts；完整脱敏元数据见 [live-smoke-results.json](./live-smoke-results.json)。
该脚本独立于 npm test，必须显式 JEV_ROUTER_LIVE=1。执行入口：

	export PI_ROUTER_HOST_MODULE=/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js
	JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts core
	JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts cancel
	JEV_ROUTER_LIVE=1 node scripts/live-agent-smoke.ts retry

core 最终日志与退出码：/tmp/jev-live-core-final.log、/tmp/jev-live-core-final.exit（值 0）。
cancel/retry 日志：/tmp/jev-live-cancel.log、/tmp/jev-live-retry.log，最终 status 均为 passed。
原始合成会话和 metadata 保留在各次命令打印的临时目录；仓库 JSON 将临时路径归一化。
这三次主证据合计 15 次 HTTP 尝试、12 次 chat dispatch，其中一次为人工注入的 503。
这些数值不包含探索性运行，不能据此计算整轮总费用。

### 隔离与选模

- Node v24.15.0、pi 1.2.0，使用真实 createAgentSession、生产 router 与内建 Codemode。
- 内存复用现有 provider 定义，只保留授权的两个模型；auth/store、cwd、session 和 router config 均隔离。
- 不加载个人扩展、skills、MCP、提示词或上下文文件。任务及文件都是合成测试材料。
- standard/complex=gpt-6.1-sol，implementation/direct=gpt-6-luna，thinking=low。
  使用 slot/phase/stageSeq 验证 standard 与 complex，不能单看同名物理模型。
- 测试 decisionTimeoutMs=15000；输入模式保持默认 last-user-only，历史 opt-in 的投影契约仍由离线及真实 SessionManager 测试验证。
- 每次进程最多 64 次 HTTP 尝试、32 次 chat dispatch；操作设 90 秒取消，全局截止 600 秒并阻止后续场景继续。
- 最终 core 的每次请求前重开磁盘 SessionManager，断言磁盘 state = 内存 state = route 结果；direct 不改持久 phase。
- 增强磁盘和续接断言后只重跑 core；cancel/retry 保留此前的真实通过记录，不声称它们执行过新增的全部公共检查。

### 实际通过的 8 项检查

1. 简单任务 Jev 返回 p(complex)=0，slot=standard、stage=1；真实 Codemode nested write 写出 marker.txt，
   下一 continuation 交接 luna，slot=implementation、stage=2。每次 dispatch 前的磁盘与内存状态一致。
2. 销毁实例，重建 ModelRuntime/AgentSession，显式选择 jev/auto；通过公开 sendCustomMessage(triggerTurn)
   触发扩展续接，实际 reason=continuation、没有新增原生 user entry、分类次数为 0，保持 luna/stage2。
   这是重建 session 后的扩展续接测试，不是交互式 /resume UI 测试。
3. 新复杂任务涉及分布式调度、租约 fencing、崩溃恢复和一致性权衡，真实 Jev 返回 p=1；
   升至 sol / planning / complex / locked，stage2→3。真实写出 design.txt，写后 continuation 保持 sol。
4. 升级后新的简单请求保持 complex/stage3，不再调用分类器。
5. 真实 session.compact() 调用 direct luna 并写入带 usage 的 compaction entry；销毁并重开后，
   扩展触发的 continuation 仍为 sol/complex/stage3，同一用户边界未重复分类。
6. 另建独立 SessionManager，从升级前的 implementation 祖先创建持久 fork；新实例实际响应使用 luna/stage2，
   独立重开原会话仍为 complex/stage3，未继承后代状态。
7. 在实际 classifier HTTP 调用开始后约 25ms 由 caller abort，等待 prompt、abort 与分类 promise 收敛；
   分类 stopReason=aborted、chat dispatch=0、无路由 state。宿主本地生成的 auto/aborted 消息不是主模型调用。
8. fetch 层明确注入一次 503，并关闭 provider 内部重试。观察到宿主 auto_retry_start、下一 route reason=retry、
   failedModel=sol / failedThinkingLevel=low；恢复后的真实 LLM stop 响应仍为 sol/low。
   stageSeq 保持 1、handoff=locked、分类次数 0。这验证受控恢复，不代表观察到了自然服务故障。

### 直接分类与 /session 记账

读取 AgentSession.getSessionStats() 的真实汇总，复核磁盘中的全部 assistant、tool、usage 和 compaction。
本机 pi 1.2.0 的扩展直接 classify 没有生成计入会话统计的 usage entry，分类用量被漏记：

- 初始两条助手响应合计 input=5711、output=50、cacheRead=4608，/session 同值（total=10369）；另有分类 input=409、output=33 没有进入会话总数。
- 原会话压缩并重开后的助手合计 input=12676、output=464、cacheRead=24960；
  compaction 合计 input=1790、output=454、cacheRead=8064。
- /session 为 input=14466、output=918、cacheRead=33024、total=48408，恰为助手加 compaction；
  工具和其他 usage 为 0，没有重复计入 compaction。
- 两次外部分类合计 input=876、output=66，未进入上述统计。需单独统计，升级宿主后重新核对。
- 目录返回的 classifier cost=0 仍按价格未知处理；chat cost 只是宿主按目录估算，未独立核账。

这项已确认的宿主记账限制不改变路由规则；本计划要求查明是否计入，没有授权改宿主补账。

### 探索与修正记录

- 最初脚本字符串转义错误，解析阶段失败，未发网络请求；修正后通过 node --check。
- 第一次在线 core 已通过真实写入交接，随后直接 agent.continue() 入口报 Error；当时未保留原始诊断栈，
  不把它作为产品缺陷结论。更换为公开扩展消息入口后完整 core 通过。
- 首次完整 core 的 6 项检查均通过，但 createBranchedSession 会切换调用方 manager，导致 resume 结尾快照落在 fork。
  改为独立 manager 创建 fork，并增加磁盘状态比对和续接边界断言；只重跑 core，最终 exit 0。
- cancel/retry 已通过且未受该记录修正影响，保留其真实结果，未为增加次数而重复调用。

### 结论边界

本机 pi 1.2.0 与获准 provider 的合成任务已覆盖本计划要求的真实主模型、Codemode、升级、取消、retry、
持久恢复、fork、compaction 和分类记账检查。M1/M2 及当前宿主在线验收完成，未 commit、push 或发布。
没有执行交互式 UI 操作、默认 openai-codex 连接、所有宿主版本兼容测试、准确率对照或缓存/成本收益实验。
H 节的 36 次策略比较与阶段评分影子实验仍为后续独立工作，没有编造实验结果。

## P1 追加验收（当前）

用户要求先完成分类账和默认 fixed 路径两项改进，再做真实 LLM 测试。
交付详见 [002 记录](./002-p1-accounting-fixed-codemode.md)，脱敏元数据见 [p1-live-smoke-results.json](./p1-live-smoke-results.json)。

新增 /jev-usage，支持 --session、--json；独立分类账使用公开 appendEntry API。
模型上下文和路由 state 不含账本，未通过只读 SessionManager 越权写 usage entry。
默认 fixed 改为同时识别成功的 nested edit/write，保持原 phase/model 状态、一次交接和后续不重判。
失败、未完成、read、空外壳和旧用户边界的负例均验证。

- 修改及新增范围追加 test/usage.test.ts、test/host-session.test.ts 的 T61、计划 002 与 P1 evidence。
- 红阶段聚焦输出为 11 fail；实现后相应测试通过。
- 默认 npm test：171 tests、166 pass、0 fail、5 skip（真实宿主用例未显式启用）、exit 0。
- PI_ROUTER_HOST_MODULE 指向本机 pi 1.2.0 后 npm test：171 tests、171 pass、0 fail、0 skip、exit 0。
- 本轮真实执行 fixed/core/cancel/retry，各自 /tmp/jev-p1-live-<scenario>.exit 均为 0。
- 同一脚本 SHA256 b75016d2742fd9fef126c28e29194cc1fe31e32fbc8251004f060a37ada9ef6b，合计 10 项场景检查、9 次真实查询。
- fixed 省略 strategy 配置，真实写入后 sol→luna；后续新请求和重开 continuation 维持 luna。
- fixed 的唯一分类 input=395/output=33；重开和查询仍只有 1 次，没有再次累加。
- adaptive 使用默认 3000ms 决策预算，core p=0/p=1 分别耗时 702/580ms；升级及锁定通过。
- 原分支压缩/重开后 ledger=2 次、input=876/output=66；祖先 fork=1 次、input=409/output=33。
- retry 先做真实分类 input=372/output=33，再注入一次 503，观察宿主自动 retry；ledger 仍为 1 次。
- cancel 在实际分类 HTTP 开始后终止：0 chat、无路由 state；ledger=1 次、missingUsageCalls=1、cost=unknown。
- 9 次 /jev-usage --json 查询不发 HTTP、不发 chat、不改 leaf，并与会话记录重建完全一致。
- 本轮合计 21 次 HTTP 尝试、16 次 chat dispatch，含 1 次人工注入 503；4 次已报告分类合计 input=1643/output=132。
  另有 1 次取消缺失用量，不能据此宣称精确总 token 或总费用；不包含此前历史运行。

原生 /session 的分类用量缺口仍然存在，新增 ledger 单列提供查询，不伪造助手消息或修改宿主。
重开/压缩/fork 不丢记录，同 callId 快照去重，实际新分类另计；未知价格/未报告用量不填零。
旧调用不回填；fork 的祖先成本也不与父会话重复加总。宿主升级后先核对是否已自动统计，再决定是否合并。

源码和元数据已对照，未新增依赖、未改用户配置、凭据、宿主，未 commit、push、发布。

## Markdown 与 HTML

plans/jev-hiroute-review.md 是唯一规格。使用现有 answer-me-with-html am.mjs 渲染阅读版，
关闭自动打开浏览器。核对 HTML 的 am-source 与 Markdown（包括 frontmatter）一致。
G 节六项 M1 和五项 M2 完成标准对应本记录的本地、宿主及在线证据。
