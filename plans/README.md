# 实施计划

当前最终整合版见 [003：最终路由实现与验证](./003-final-router.md)。以下 001/002 及其在线结果是 feat 基线的历史记录；涉及初始交接、fixed 输入和取消的描述已被 003 取代。

更新日期：2026-10-16。规划基线 commit：bb854b2e8f91b70dfc95a0a679966d37dd3348fa。

## 计划 001：有限动态升级

- [完整实施规格](./jev-hiroute-review.md)
- [HTML 阅读版](./jev-hiroute-review.html)
- [详细验收记录](./validation.md)
- [真实调用脱敏元数据](./live-smoke-results.json)
- 优先级 P1，工作量 L，风险中。
- 总状态：已完成实现与本机验收；未 commit、push 或发布。
- M1 有限升级：已完成，离线验收通过。
- M2 有界历史与宿主验证：已完成，本机 pi 1.2.0 真实 SessionManager 专项零 skip。
- 真实 agent loop smoke：首轮 core/cancel/retry 共 8 项通过；P1 追加 fixed 后四场景共 10 项复测通过，均使用用户授权的 codex-sub2api sol/luna。
- 已确认限制：pi 1.2.0 的扩展直接 classify usage 未进入 /session；后续 P1 已交付 /jev-usage 独立分类账。压缩 usage 正常计入。

完整规格只维护在 Markdown，HTML 从它生成。实现、离线、宿主专项和在线 smoke 分别记录。
真实调用使用合成任务，不把 stub 或手工 append 状态当作真实 Codemode/主模型执行。

## 执行顺序与状态

1. 固定当前行为与测试入口：已完成。基线 25/25，新 fixed 表征后 35/35；
   route harness 模拟新 state 先保存。证据见 validation.md 的步骤 1、T01–T06。
2. 加入策略配置与版本状态：已完成。严格配置、合并、默认值、example 深比较、迁移和版本校验；
   npm test -- test/config.test.ts test/route.test.ts 通过。
3. 实现分类结果与有限升级：已完成。具名结果、用户 ID 去重、caller/预算取消、答案校验、
   simple/不可用保持、complex 升级。T07–T24 和迟到结果断言通过。
4. 初始交接、retry 与恢复：已完成。nested ok、外层失败、旧边界排除、failed 强度、
   配置恢复、同 ID 多槽位和不重复持久化，T25–T49 通过。
5. 决策记录与 M1 文档：已完成。字段白名单、敏感哨兵和 unknown 价格；
   README 中英文同步，fixed 默认行为保留，git diff --check 通过。
6. 默认关闭的有界历史：已完成。T50–T56、整轮/UTF-16 预算、来源投影和隐藏正文 payload 断言通过。
7. 真实宿主状态与验收记录：已完成。T57–T60 专项 4/4、零 skip；
   追加真实 agent loop 的 6 项 core、1 项 cancel、1 项 retry 检查。

步骤 1–5 为 M1；步骤 6–7 为 M2。当前已完成本机 pi 1.2.0 和授权 provider 的验收。
不扩展为全部宿主、交互式 UI 或默认 openai-codex 连接的兼容声明。
H 节的策略对照和阶段评分影子实验仍是后续独立工作。

## 计划 001 首轮验证证据（历史）

- npm test -- test/config.test.ts test/route.test.ts：149 tests，149 pass，0 fail。
- npm test：153 tests，149 pass，0 fail，4 skipped（具名宿主用例）。
- PI_ROUTER_HOST_MODULE 指向本机 pi 公共入口后 npm test：153 tests，153 pass，0 fail，0 skipped。
- 宿主专项：4 tests，4 pass，0 fail，0 skipped；显式错误入口会 fail，不静默 skip。
- scripts/live-agent-smoke.ts 的 core/cancel/retry 均 passed；core 最终 exit 0。
- standard/complex=codex-sub2api/gpt-6.1-sol，implementation/direct=gpt-6-luna；
  初始真实 Jev p=0，写后 sol→luna；新复杂请求 p=1，luna→complex sol，后续不降级。
- 最终 core 每次主调用前重开磁盘比对状态；公开扩展消息触发 continuation 时无新原生 user、无重复分类。
  cancel/retry 保留增强公共断言前的真实通过记录，不扩张其检查范围。
- 真实 compaction 用 direct luna，重开保持 complex；祖先 fork 保持 implementation，原分支不受污染。
- 真实分类 HTTP 开始后 abort：主调用 0、无路由 state。人工 503 后观察到宿主 retry，再获真实 LLM 成功响应。
- 两次分类 input=876/output=66 未进 /session；助手加压缩 usage 与总数一致，无压缩重复计账。
- Node v24.15.0，pi 1.2.0；未改依赖、宿主、用户配置或凭据；目录零报价不当作免费。

脚本为显式 opt-in，不进入 npm test；原始合成会话留在临时目录，仓库 JSON 仅保留脱敏元数据。
首次探索失败与记录修正也已保留说明。完整命令、阶段证据和限制见 [validation.md](./validation.md)。

## P1 追加改进：已完成

- [002：分类账与 fixed Codemode 交接](./002-p1-accounting-fixed-codemode.md)
- [本轮真实调用证据](./p1-live-smoke-results.json)
- /jev-usage（分支）、--session（当前文件全部分支）、--json 已交付，独立于 debug 持久化。
- 默认 fixed 扩展识别成功 nested edit/write，保持两阶段状态和后续不重分类规则。
- 最新宿主完整套件 171 pass、0 fail、0 skip；T61 验证账本真实保存、重开、压缩与 fork。
- 同一脚本版本的 fixed/core/cancel/retry 共 10 项真实检查通过，四进程均 exit 0。
- 9 次真实查询均不发模型请求、不变更 leaf；retry 的分类只记一次，取消未知用量不当作免费。
- 4 次已报告分类用量合计 input=1643/output=132；另 1 次取消缺失用量。
- 当前本机验收已完成，未 commit、push 或发布；旧首轮证据保留，不将旧脚本结果当作本轮复测。

## 已确认的取舍

- fixed 保留默认、一次交接和旧状态格式；P1 经授权扩展 nested write/edit 成功证据。
- adaptive 只允许复杂结果升级，简单结果与分类失败保持当前模型。
- 初始阶段保留写入交接；升级后锁定规划阶段。
- 历史外发默认关闭，独立于动态路由开关。
- 不新增 confidence 门槛，不直接复制 HiRoute 阈值或成本收益。
- 阶段评分先做影子实验；自动降级、多 provider 与类别路由后置。

## 阅读版维护

使用 answer-me-with-html 的 am.mjs 从主计划渲染 HTML，并核对 am-source 与 Markdown 一致。
不要手工维护第二份规格。.html-cache/ 仅为本地缓存，不是交付物或验收证据。
