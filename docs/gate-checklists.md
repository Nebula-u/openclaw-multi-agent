# StateGraph Local Gate

Gate 由宿主代码计算，Agent 只提供自检候选项。任何 blocking item 不是 `PASS` 或 `NOT_APPLICABLE` 时，Gate 失败并触发 task attempt 重试。

## 通用项

- result status 为 `COMPLETED`；
- preflight 通过；
- policy 要求的 checks 全部提供并通过；
- context manifest、身份、路径和引用 SHA 已由 ingestion 验证；
- 不存在未绑定或过期的人工审批。

## 阶段检查

| 阶段 | 代码要求 |
| --- | --- |
| REQUIREMENTS | scope、boundaries、acceptance criteria |
| ARCHITECTURE | constraints、data flow、risks |
| DESIGN | interaction states、accessibility、responsive layout |
| DEVELOPMENT | implementation、build、static checks、commit binding |
| CODE_REVIEW | candidate binding、findings、regression risk |
| TEST | test execution、regression、failure evidence、command evidence、Docker attestation、commit binding |
| RELEASE | candidate binding、rollback、release readiness |

## Commit binding

DEVELOPMENT/TEST 的 output commit 必须为完整 SHA、存在、是 input commit 后代并等于当前 worktree HEAD。其他阶段返回不同 output commit 时 `commit_scope` 失败。

## TEST Gate

TEST 至少引用一个 CommandRecord，并且 task 持有代码验证的 Docker attestation。result isolation mode 必须为 `SANDBOXED_DOCKER`。daemon、container、mount、network、rootfs、capabilities 或资源限制无法验证时失败关闭，不提供人工“无沙箱例外”直通。

## 人工审批

阶段后人工审批只在 Gate PASS 后出现。批准不会修改 Gate；它只决定接受当前已通过结果、让同一 Agent 重做或终止。审批绑定 candidate，不能批准另一个 commit。

## 失败证据

Gate JSON 写入 `<artifact_root>/output/local-gate.json`，并随 task 错误摘要进入 checkpoint。失败 run 和原始输出保留；下一 attempt 不覆盖。
