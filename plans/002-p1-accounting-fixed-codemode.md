# 002 P1：分类账与默认 fixed 的 Codemode 交接

状态：已完成实现、离线/真实宿主回归及四场景真实 LLM 复测。日期：2026-10-16。
用户在计划 001 验收后明确授权这两项改进；这是对原 fixed 仅识别外层写入的范围修订。
未修改用户配置、凭据、宿主或依赖，未 commit、push、发布。

## 交付

1. 扩展通过公开 pi.appendEntry 保存 pi-jev-router.classifier-usage 自定义记录，独立于 debug。
   每次真正进入 classify 的尝试有随机 callId、pending 与 terminal 快照；查询按 ID 去重。
   不将记账累加器写入 route state，不通过只读 SessionManager 写宿主 usage entry。
2. /jev-usage 查询当前 branch，--session 查询当前文件所有分支，--json 输出结构化数据。
   SDK 可使用同文件导出的 summarizeClassifierUsage。命令不产生 LLM 请求、不写会话。
3. 记录只包含 schemaVersion、调用和模型身份、状态及白名单数值用量；不记录正文、凭据或原始错误。
   未报告 token、pending、未知价格均明确保留；knownCost 只是已知小计。旧版本调用不回填。
4. 重开/压缩保留记录，fork 继承祖先记录；重复快照不累加，重试主模型不新增分类尝试。
   同用户取消后实际再调用 classify 是新的尝试；timeout 后迟到结果不能写入账本。
5. fixed 支持成功外层 edit/write，以及任意工具结果中 nestedCalls.calls 的 edit/write status=ok。
   外壳成功不足以交接；nested error/unfinished/read 不交接。外层失败或 complete=false 中的独立成功写入仍有效。
   仍按当前最后 user 边界过滤，只交接一次，后续用户不重新分类，原 phase/model 状态保持。

## 验证

- 先新增回归并观察 11 项预期失败，再实现。完整真实宿主套件 171/171 通过、0 skip。
- 新增 test/usage.test.ts 的 10 项测试；fixed 新增 7 项边界回归，旧 nested-write 预期按本授权更新。
- 真实 SessionManager 新增 T61，实际保存/重开/压缩/持久 fork 后比较账本。
- 真实 LLM 使用同一版 scripts/live-agent-smoke.ts：fixed 2、core 6、cancel 1、retry 1，共 10 项检查。
- 四个进程均 exit 0。脚本 SHA256 为 b75016d2742fd9fef126c28e29194cc1fe31e32fbc8251004f060a37ada9ef6b。
- fixed 配置省略 strategy，真实 Codemode 写入后 sol→luna，后续新用户与重开续接不重新分类。
- adaptive 使用默认 3000ms 分类预算；真实 p=0→标准，p=1→complex，写后锁定不变。
- core 原分支压缩/重开后记 2 次分类 input=876/output=66，祖先 fork 仅 1 次 input=409/output=33。
- retry 启用真实 Jev，注入一次 503 后观察宿主 retry，分类实际仅调用和记账 1 次（input=372/output=33）。
- cancel 在真实分类 HTTP 开始后 abort：0 chat、无路由 state，1 次分类尝试无报告用量，cost=unknown。
- 9 次真实 /jev-usage 查询均与记录重建一致；HTTP/chat 计数和会话 leaf 均未变化。

## 结果与限制

完整脱敏证据：[p1-live-smoke-results.json](./p1-live-smoke-results.json)。
命令日志 /tmp/jev-p1-live-{fixed,core,cancel,retry}.log；对应 .exit 全为 0。
本轮复测共 21 次 HTTP 尝试、16 次 chat dispatch，其中一次是明确人工注入的 503。
4 次报告用量的分类合计 input=1643/output=132；另有 1 次取消调用用量未知，不能按零计费。
这些数值仅覆盖本轮四个场景，不包含此前探索或验收调用。

pi 1.2.0 的 /session 仍只统计助手等宿主 usage；新增账本单列分类用量，并未伪造助手消息或修改宿主。
价格未知不填零，继承的 fork 费用不能和父文件再次累加。宿主升级后须重新检查是否需要合并两份统计。
本轮验证限定本机 pi 1.2.0 和 codex-sub2api sol/luna；不宣称质量、准确率或成本收益已做对照。
原计划 H 的策略比较仍独立后置。
