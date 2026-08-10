# EVIDENCE_RULES.md — 事实、证据与命令日志规则

> 版本: evidence-rules v1

## 1. 事实四级分类

| 分类 | 含义 | 要求 |
|------|------|------|
| `OBSERVED` | 实际从用户输入、文件、Git、命令或官方文档观察到 | **必须**有证据引用 |
| `INFERRED` | 基于观察事实的推断 | 必须写出依据与限制 |
| `PROPOSED` | 建议 / 设计 | 不得写成"已实现" |
| `UNKNOWN` | 缺证据或无法验证 | 明确标注，不猜测 |

## 2. 严禁（造假清单）

- 编造命令输出、commit hash、文件行号、测试覆盖率、工具版本、安全扫描结果。
- 把"计划执行"写成"已经执行"。
- 删除失败日志只保留成功日志。
- 把模型内部思维链当作证据。
- 用"看起来没问题"代替证据。

## 3. claim 结构（`result.json.claims[]`）

每条 claim 至少含：`claim_id`、`statement`、`classification`（四级之一）、`evidence_refs`（evidence_id 列表）、`limitations`、`observed_at`。

## 4. evidence 结构（`output/evidence.jsonl`，每行一条）

每条 evidence 至少含：`evidence_id`、`source_type`（file/git/command/doc/...）、`locator_abs` 或 Git locator、`sha256`、`line_start`/`line_end`（适用时）、`collected_at`、`collector`、`command_record_id`（适用时）、`notes`。

## 5. 命令记录（`output/command-records.jsonl`，每行一条）

所有构建、测试、格式化、扫描与关键 Git 命令必须保留真实记录。**不得新增 Python CommandRunner**；直接用 OpenClaw 原生 Shell 工具执行并保存日志。

每条 CommandRecord 至少含：
`command_record_id`、`argv` 或准确命令文本、`executable`、`executable_version`、`cwd_abs`、`started_at`、`finished_at`、`exit_code`、`timed_out`、`stdout_path_abs`、`stderr_path_abs`、`stdout_sha256`、`stderr_sha256`、`attempt`、`invoked_by_agent`、`task_id`、`run_id`、`isolation_mode`、`redactions_applied`。

### 规则

1. stdout / stderr 保存为**独立原始文件**（`raw-logs/` 下）。
2. 保留退出码与绝对 `cwd`。
3. 重试生成**新**日志与**新** CommandRecord，不覆盖第一次失败。
4. 不记录 token / password / cookie / private key / 完整凭证（`redactions_applied` 标记脱敏）。
5. Shell 工具若返回结构化结果，也要把关键原始结果落盘到 artifact。
6. 默认不允许网络、依赖安装、破坏性命令。
7. 未执行的检查标记 `NOT_EXECUTED` 或 `UNKNOWN`，不得假装执行。

## 6. 校验和

- 每个 run 的关键产物写入 `checksums.sha256`（可用 PowerShell `Get-FileHash`、`sha256sum`、`shasum -a 256` 等原生工具计算，**不用** Python 脚本）。
- Control Kernel v2 的 workflow/task event 使用 SHA-256 哈希链；`runtime/control/v2/**` 中的 `events.jsonl` 只是只读投影。
