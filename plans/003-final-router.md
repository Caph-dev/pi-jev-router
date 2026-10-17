# 003：基于 feat 的最终整合版

## 交付位置与基线

- 工作目录：`/Users/caph/Workspace/pi-packages/pi-jev-router-final`。
- 新分支：`feat/final-router`，创建自 `feat/adaptive-routing`。
- Git HEAD：`bb854b2e8f91b70dfc95a0a679966d37dd3348fa`。main 与 feat 的差异原本都在未提交工作树中，不能仅用分支提交解释实现来源。
- 创建后复制 feat 的全部 20 个 tracked / 非忽略 untracked 文件，并逐文件验证 SHA-256 一致。
- 原始指纹：[003-feat-baseline.json](003-feat-baseline.json)。复制未包含被忽略的依赖目录或个人配置。
- 完成时再次核验：feat 20 个文件、main 41 个文件与操作前完全一致。
- 此工作树未 commit、push、发布或安装到用户 Pi；package version 保持 0.2.0，不代表新发布版本。

## 实现结果

### 所有策略共享的边界

- fixed 改用与 adaptive 相同的有期限分类执行器。保留 3000ms 默认值和 adaptive.decisionTimeoutMs 配置名，该期限现在适用于所有策略；SDK maxRetries=0。
- caller 取消、服务 aborted 和 AbortError 终止路由，不返回候选状态。deadline 胜出后忽略晚到成功/失败。
- 三种策略均从原生用户 entry 取身份，只发送投影后的可见文本。fixed 保留 state.prompt，adaptive 保留 state.current；不从转换后的 role=user 猜来源。
- 分类期间会话、分支锚点或当前投影输入失效时中止应用结果。
- retry 在交接判断之前处理，保持合规 failed 物理模型和 thinking level，锁定旧交接，不重新分类。
- fixed 的失踪/跨 provider 状态模型回退 standard，返回修复后的锁定状态，避免旧写入立即触发降级。
- fixed/adaptive 的 implementation 目标缺失时保留当前模型。初始目标、direct 目标或必要 standard 缺失仍明确报配置错误。
- 分类账和诊断持久化失败不会影响分类执行或路由，只输出脱敏提示。

### 保留 feat 的能力

- 原生 entry ID 去重、会话投影、有界历史与上下文编辑语义。
- Codemode 等外层工具记录中的成功 nested edit/write，当前 user 与阶段 anchor 边界。
- /jev-usage、分支/全会话分类账、未知费用表示、重开/压缩/fork 统计。
- fixed 默认策略、配置文件发现顺序和物理模型/思考强度设置。

### adaptive 交接保护

默认 handoffPolicy=guarded。只有初始 standard 的完整无图输入得到有效 pComplex≤0.2 且低于复杂阈值，当前输入仍匹配分类证据，已发生成功写入，且已知上下文≤50000 tokens 时才能交接。

初始 complex 锁定。分类不可用、无证据的模型复用、截断、图片、未知上下文均不能授权 guarded 交接。证据只存输入哈希和概率，不存正文。后续升级保持锁定，用户边界去重不变。

显式 handoffPolicy=first-write 保留 feat 原始初始交接语义，包括初始 complex 或分类不可用后的交接。嵌套成功仍可采信于外层失败或不完整记录；这是“已成功写入”的证据，不是“任务已完成”的证据。

旧 adaptive-v1 / phase-model 状态迁移为 adaptive-v2 时锁定旧交接；未知 schema 仍明确报错。配置变更和丢失锚点关闭旧资格。

### shadow 与诊断

- 新增 strategy=shadow，实际模型沿 fixed 路由，只观察后续原生用户输入是否建议升级。建议不会应用，不维护完整的另一条 adaptive 模拟轨迹。
- shadow 去重 ID 持久化；continuation/retry 不重分类。建议以结构化 stderr 输出，可配合持久化诊断。
- diagnostics.record 默认 false。启用后保存 decision 与主助手消息 outcome，用随机 decisionId 关联。
- outcome 记录实际模型、thinking level、stopReason、失败类别、脱敏 usage 和路由后的耗时。不声称测量首 token 或 HTTP 状态。
- outcome 核对会话和分支祖先，且在真实宿主事件 session_before_switch / session_tree / session_start / agent_end / session_shutdown 清理待关联记录。
- 分类账、Pi 主模型 usage、outcome 的不同用途已写入 README，避免重复计费汇总。

## 回归与接口验证

新回归测试先在旧实现上失败，再用于验证修复。

1. 第一组 12 个定向探针中 10 个失败，复现 fixed 的取消、retry、输入来源、期限、异常概率和两种策略的目标缺失。
2. guarded 交接测试初次 17 项中 15 项失败，覆盖 complex、简单阈值、上下文、图片、截断、输入替换与迁移。
3. shadow/diagnostic 8 项初次全部失败，随后验证去重、未应用建议、结果关联和会话/分支隔离。
4. 真实 SessionManager 追加 fixed 的投影来源、重开后 retry 锁定与目录缺失状态修复；所有宿主用例采用真实 convertToLlm 作为请求输入。
5. 新增分类期切会话、持久化写入失败的回归；同时保留原 feat 的 ledger、compaction、fork 和 history 检查。
6. 严格类型检查发现并修正旧分类输入 JSON 类型声明、Promise 联合类型收窄，以及主线方案中沿用的非宿主事件 session_switch。最终使用宿主真实支持的 session_before_switch。
7. live 脚本的 fixed 状态断言适配新增字段，core 改为要求 pComplex≤0.2。入口测试证明未显式 opt-in 时在读取个人配置前拒绝执行。

## 最终验收结果

### 离线与真实 SessionManager

~~~sh
cd /Users/caph/Workspace/pi-packages/pi-jev-router-final
PI_ROUTER_HOST_MODULE=/Users/caph/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js npm test
~~~

~~~text
tests 232
suites 27
pass 232
fail 0
cancelled 0
skipped 0
~~~

本轮实际安装版本为 Pi 1.3.0 / Node 24.15.0，已读取宿主 package.json 和 process.version 核验。继承的在线报告仍对应 Pi 1.2.0。未设置 PI_ROUTER_HOST_MODULE 时，真实宿主用例按设计具名 skip；不能把这种运行称作完整宿主验收。

### 类型与打包

生产入口和 diagnostics 模块用本机已安装 TypeScript 对真实 Pi / pi-ai 声明做 strict + noEmit 检查，exit 0。
没有全局或项目依赖安装。仓库当前只有 npm test script，没有独立 lint/typecheck script；本次类型检查使用临时 tsconfig，参数为 ES2023、NodeNext、allowImportingTsExtensions、skipLibCheck，paths 指向本机宿主声明，typeRoots 指向现有 @types。

本次实际执行的命令：

~~~sh
node /Users/caph/.pi/agent/npm/node_modules/typescript/lib/tsc.js \
  --project /var/folders/fc/qdm51jvd7f11661zwl42j58r0000gn/T/jev-final-baseline-5jrd7y5r/tsconfig.json
git diff --check
npm pack --dry-run --ignore-scripts --json
~~~

三项均 exit 0。打包预览包含 LICENSE、README.md、package.json、jev-router.example.json，以及两个 runtime TypeScript 文件；没有打入 plans、测试、个人配置或凭据。dry-run 未发布包。

## 验证边界

- 本次零在线模型请求；没有重新执行 billable live smoke 或 main/feat/final 的统一 A/B。
- 232 个测试及类型检查验证路由行为、持久状态和接口；不证明 Jev 准确率、主模型任务质量、生产时延或节省费用。
- 原 plans/validation.md、live-smoke-results.json、p1-live-smoke-results.json 是继承的 feat 历史验收，不是本版本的在线结果。
- guarded 阈值是从 main 引入的可配置保护条件，尚未证明为最优；复杂模型可能长期锁定并增加费用。
- 未覆盖所有宿主版本、交互 UI 和所有 provider。嵌套写入依赖宿主持久记录，分类账缺失上报时保留 unknown。

## 审阅与后续

代码主入口为 extensions/jev-router.ts；结果诊断在 extensions/lib/diagnostics.ts。README 和 example 已同步。

因为原 feat 实现未提交，git diff HEAD 包含整个 feat 快照及最终增量。只看本次相对 feat 的修改时，可对照两个 worktree 的相同路径，例如：

~~~sh
git diff --no-index \
  /Users/caph/Workspace/pi-packages/pi-jev-router-adaptive-routing/extensions/jev-router.ts \
  /Users/caph/Workspace/pi-packages/pi-jev-router-final/extensions/jev-router.ts
~~~

有差异时该命令返回 1 属于正常 diff 结果。后续如需验证质量/费用，应让 fixed、guarded adaptive、first-write adaptive 和固定物理模型跑相同任务及隐藏检查；本次不据离线通过结果推断优劣。
