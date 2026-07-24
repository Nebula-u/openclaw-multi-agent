# evidence-and-claims.md — 事实分类、Claim、Evidence 与 CommandRecord

> 版本: evidence-and-claims v1
> 本文件是面向全体 Agent 与文档读者的操作说明，权威定义以 `agents/common/EVIDENCE_RULES.md`（evidence-rules v1）与 `contracts/` 下的 schema 为准。
> 散文用中文；命令、字段名、状态值、标识符用英文。

## 1. 为什么需要证据纪律

本系统的每一条对外结论都必须**可审计、可追溯、可复核**。任何 Agent 都不得凭“看起来没问题”推进流程，也不得把模型内部推理当作事实来源。所有 `OBSERVED` 结论都必须指向一份可复核的证据（文件 + 行号 / Git locator / 命令日志）。

## 2. 事实四级分类（classification）

每一条陈述在写入 report 或 `result.json.claims[]` 时，都必须打上下列四级之一：

| classification | 含义 | 硬性要求 |
|----------------|------|----------|
| `OBSERVED` | 实际从用户输入、文件、Git、命令输出或官方文档中观察到 | **必须**有 `evidence_refs`；缺证据不得标 OBSERVED |
| `INFERRED` | 基于已观察事实做出的推断 | 必须写出推断依据（引用被依赖的 evidence）与 `limitations` |
| `PROPOSED` | 建议、设计、计划 | **不得**写成“已实现 / 已执行 / 已通过” |
| `UNKNOWN` | 缺证据或无法验证 | 明确标注，**不得**猜测填充，不得默认当作 PASS |

分级原则：不确定时降级为 `UNKNOWN`；是设计或计划时用 `PROPOSED`；只有拿到可复核证据才可升级为 `OBSERVED`。

## 3. Claim 结构（写入 `result.json.claims[]`）

每条 claim 至少包含以下字段：

| 字段 | 说明 |
|------|------|
| `claim_id` | claim 的唯一标识 |
| `statement` | 陈述本身（一句可核对的事实或结论） |
| `classification` | 四级之一：`OBSERVED` / `INFERRED` / `PROPOSED` / `UNKNOWN` |
| `evidence_refs` | 关联的 `evidence_id` 列表；`OBSERVED` 必须非空 |
| `limitations` | 该 claim 的适用边界、未覆盖情形、已知不确定性 |
| `observed_at` | 观察 / 生成时间（date-time） |

要求：一条 claim 只承载一个可核对的事实；把多个事实塞进一条 statement 会破坏可追溯性。`INFERRED` 的 `evidence_refs` 指向其推断所依赖的观察证据。

## 4. Evidence 结构（`output/evidence.jsonl`，每行一条）

权威 schema：`contracts/evidence.schema.json`。每条 evidence 至少包含：

| 字段 | 说明 |
|------|------|
| `evidence_id` | 唯一标识，形如 `EVD-...` |
| `source_type` | `file` / `git` / `command` / `doc` / `user_input` / `config` / `other` |
| `locator_abs` | 证据的**绝对**文件路径（file/command/config 来源）；不得用相对路径 |
| `git_locator` | Git 来源定位，如 `<commit>:<path>` 或 `<commit>` |
| `sha256` | 证据内容的 SHA-256（适用时） |
| `line_start` / `line_end` | 文件内的行号范围（适用时） |
| `collected_at` | 采集时间（date-time） |
| `collector` | 采集者（Agent ID） |
| `command_record_id` | 若证据来自命令执行，关联对应 CommandRecord |
| `notes` | 补充说明 |

`locator_abs` 与 `line_start`/`line_end` 让每条 `OBSERVED` claim 可被人工回到原始位置复核。命令类证据必须通过 `command_record_id` 挂接到 CommandRecord。

## 5. CommandRecord（`output/command-records.jsonl`，每行一条）

权威 schema：`contracts/command-record.schema.json`。所有构建、测试、格式化、扫描与关键 Git 命令**必须**保留真实记录。**不得新增 Python CommandRunner / 控制平面**；直接用 OpenClaw 原生 Shell 工具执行并把原始输出落盘。

每条 CommandRecord 至少包含：

| 字段 | 说明 |
|------|------|
| `command_record_id` | 唯一标识 |
| `argv` 或 `command_text` | 准确的命令数组或命令文本 |
| `executable` | 可执行程序名 |
| `executable_version` | 工具版本（未知则为 null，不得编造） |
| `cwd_abs` | 执行时的**绝对**工作目录 |
| `started_at` / `finished_at` | 起止时间（date-time） |
| `exit_code` | 真实退出码（未产生则为 null，不得编造 0） |
| `timed_out` | 是否超时（bool） |
| `stdout_path_abs` | stdout 原始文件的**绝对**路径 |
| `stderr_path_abs` | stderr 原始文件的**绝对**路径 |
| `stdout_sha256` / `stderr_sha256` | 对应日志文件的 SHA-256 |
| `attempt` | 第几次尝试（从 1 开始） |
| `invoked_by_agent` | 发起命令的 Agent ID |
| `task_id` / `run_id` | 归属的 task / run |
| `isolation_mode` | 本阶段固定 `UNSANDBOXED_LOCAL` |
| `redactions_applied` | 是否对日志做过脱敏（bool） |

### 落盘规则

1. stdout / stderr 各自保存为**独立原始文件**（在本次 run 的 `raw-logs/` 下），CommandRecord 只存其**绝对路径**与 SHA-256。
2. 保留真实退出码与绝对 `cwd_abs`；禁止依赖当前工作目录（即使从 `C:\Windows\System32` 启动也必须用绝对路径解析）。
3. **重试生成新日志与新 CommandRecord**（`attempt` 递增），**不覆盖第一次失败**。首次失败、重试后成功时，必须保留第一次失败日志并标记**潜在 flaky**。
4. 不记录 token / password / cookie / private key / 完整凭证；脱敏后置 `redactions_applied = true`。
5. Shell 工具若返回结构化结果，也要把关键原始结果落盘为 artifact。
6. 默认不允许网络、依赖安装、破坏性命令（放开须人工审批，见 `docs/human-approval.md`）。
7. 未执行的检查标记 `NOT_EXECUTED` 或 `UNKNOWN`，**不得**假装执行。

## 6. 严禁清单（造假 = 立即失败）

以下行为在任何情况下都被禁止，一经发现该 run 结论作废：

- 编造命令输出、commit hash、文件行号、测试覆盖率、工具版本、安全扫描结果。
- 把“计划执行 / 打算执行”写成“已经执行”。
- 把 `PROPOSED`（设计 / 计划）写成“已实现”。
- 删除失败日志只保留成功日志；隐藏第一次失败。
- 把模型内部思维链（chain-of-thought）当作证据，或作为结论输出给用户。
- 用“看起来没问题”“应该可以”代替可复核证据。
- 把 `UNKNOWN` 或 `NOT_EXECUTED` 悄悄改写成 `PASS`。
- 工具未真实产出覆盖率数据时生成 `coverage-report.json`（应改标 `UNKNOWN` / `NOT_EXECUTED`）。

## 7. 重试与失败保留（强调）

重试**必须**产生新日志文件与新 CommandRecord（新的 `command_record_id`、`attempt` 递增），**绝不覆盖**第一次失败记录。测试若首次失败、重试后成功，须：

1. 保留第一次失败的 stdout/stderr 原始文件与其 CommandRecord。
2. 在 `test-report.md` 中记录哪条命令重试、第几次成功、第一次失败日志的绝对路径。
3. 标记该用例为**潜在 flaky**。

## 8. 校验和与事件链

- 每个 run 的关键产物写入 `checksums.sha256`，用系统原生工具计算（如 PowerShell `Get-FileHash`、`sha256sum`、`shasum -a 256`），**不用** Python 脚本。
- `events.jsonl` 使用 SHA-256 哈希链（`previous_event_hash` → `event_hash`），保证事件不可篡改、可复原。

## 9. 相关文件

- 规则来源：`agents/common/EVIDENCE_RULES.md`、`agents/common/COMMON_RULES.md`（第 5 节）
- Schema：`contracts/evidence.schema.json`、`contracts/command-record.schema.json`、`contracts/result.schema.json`
- 关联文档：`docs/human-approval.md`、`docs/gate-checklists.md`、`docs/unsandboxed-test-policy.md`
