# agent-contracts.md — 7 个 Agent 的输入校验与强制产物

> 权威来源：`agents/common/COMMON_RULES.md`（第 2、8 节）、`contracts/result.schema.json`、重构 Prompt 第十二、十六节。
> 文档日期：2026-07-29

## 1. 本文用途

本文规定 7 个 Agent 的**输入校验（Preflight Check）**与**强制产物**，给出 `result.json` 关键字段与 `result_status` 五值，并逐角色列出产物清单（字段名以 `contracts/*.schema.json` 为准）。

## 2. 通用输入校验（Preflight Check，所有工作 Agent）

工作 Agent 在动任何文件或命令前，必须校验并把结果写入 `result.json.self_validation`（`preflight_passed` + `checks[]`，每项 `status ∈ PASS / FAIL / UNKNOWN / NOT_APPLICABLE`）：

1. 读 `input/context-manifest.json`，确认 `workflow_id` / `task_id` / `run_id` / `assigned_agent` 与派发一致，且 `assigned_agent` == 自己的 Agent ID。
2. `target_project_root_abs` / `worktree_path_abs` / `artifact_root_abs` 均为**绝对路径**且存在。
3. worktree 路径位于允许根目录（`<runtime>\worktrees\...`）内，规范化后无 `..` / 符号链接逃逸。
4. `input_commit` 与当前 worktree `HEAD` 一致（需改代码的角色）。
5. `input/` 各文件 SHA-256 与 `context-manifest.json` 一致。

任一失败 → 不开始工作，返回 `result_status = BLOCKED`，在 `unresolved_issues` 写明失败项。

### 2.1 派发身份确认（所有工作 Agent）

若 manager 的派发消息提供 `dispatch_id` 与 input manifest SHA-256，工作 Agent 在上述 Preflight 中还必须确认二者与 `context-manifest.json`、当前 workflow/task/run/agent 身份一致。成功后只向 manager 发送 ACK；Agent 不得直接改写 `dispatch/` 中的 intent、receipt、completion 或 dead-letter。完成时先落盘并自检全部产物，通知中给出 `dispatch_id`、`result.json` 绝对路径、SHA-256 和真实 `result_status`；Manager 的独立验证与 completion receipt 才是流程事实。

## 3. 通用强制产物（所有工作 Agent）

来源 `COMMON_RULES.md` 第 8 节，每个工作 Agent 完成后至少产出：

- `output/result.json`
- `output/user-summary.md`
- `output/manager-summary.md`
- 角色正式报告（见 §6）
- `output/evidence.jsonl`
- `output/command-records.jsonl`
- `checksums.sha256`
- 需改代码的角色（developer / test）还需**真实本地 Git commit**

所有 JSON / JSONL 产物都必须用 Runtime Guard + Ajv 按对应 `contracts/*.schema.json` 本地强校验。首次失败只允许一次 JSON-only retry，只重新生成失败 JSON / JSONL，不重新完整分析；校验错误写入 `raw-logs/json-validation-errors.jsonl`，记录格式见 `contracts/json-validation-error.schema.json`。

新建任务应设置 `output_contract_version=1`，并按 `config/task-output-contracts.json` 声明 `result.json`、`evidence.jsonl`、`command-records.jsonl`。为兼容历史 run，缺少该字段的旧 task 仅按其已声明契约读取；不得回写或伪造旧 run 的声明。

JSON ingestion 保留原文 SHA-256，只允许两个确定性转换：移除 UTF-8 BOM，或在全文恰好为一个 JSON Markdown fence 时解包。不会自动补字段、修 enum、修改 ID 或篡改业务结论。JSONL 受 5 MiB 总量、1 MiB 单行限制；空 JSONL 与 evidence/command record 重复 ID 均 fail-closed。

## 4. `result.json` 关键字段（以 contract 为准）

来源 `contracts/result.schema.json`。`required`：

`schema_version`、`workflow_id`、`task_id`、`run_id`、`agent_id`、`role`、`attempt`、`started_at`、`finished_at`、`result_status`、`summary_for_user`、`summary_for_manager`、`worktree_path_abs`、`artifact_root_abs`、`isolation_mode`、`self_validation`。

其他常用字段：`input_commit`、`output_commit`、`branch`、`modified_files`、`created_files`、`deleted_files`、`report_files`、`command_record_refs`、`evidence_refs`、`claims[]`、`findings[]`、`unresolved_issues`、`known_limitations`、`decisions_required[]`、`recommended_next_action`、`git_status_after_completion`、`artifact_manifest_hash`。

约束：

- `isolation_mode` 枚举仅 `UNSANDBOXED_LOCAL`（本阶段无 sandbox）。
- `self_validation.checks[].status ∈ PASS / FAIL / UNKNOWN / NOT_APPLICABLE`。
- `claims[]` 每项含 `claim_id`、`statement`、`classification ∈ OBSERVED / INFERRED / PROPOSED / UNKNOWN`、`evidence_refs`、`limitations`、`observed_at`。

## 5. `result_status` 五值

来源 `contracts/result.schema.json`：

| 值 | 含义 |
|----|------|
| `COMPLETED` | 任务达成且自检通过 |
| `NEEDS_REWORK` | 需上游修正或本任务需重做 |
| `BLOCKED` | 环境 / 工具 / 权限阻塞，无法推进 |
| `HUMAN_DECISION_REQUIRED` | 触发人工审批节点（见 `human-approval.md`） |
| `FAILED` | 执行失败 |

工作 Agent **不擅自决定**审批节点；遇到时返回 `HUMAN_DECISION_REQUIRED` 并在 `decisions_required[]` 列出选项与影响，交由 `manager-agent` 发起审批。

`HOLD` 不属于 `result_status`，不得写入 `result.json`。它是 workflow 的状态；任务等待人工决定用 `task.status=WAITING_HUMAN`，环境或权限阻塞用 `task.status=BLOCKED`。manager 将 Agent 结果、任务状态和 workflow 状态分别按 contracts 与 `config/workflow-state-machine.json` 处理。

## 6. 各角色产物清单（引用重构 Prompt §16）

### 6.0 manager-agent

`manager-agent` 不产出 `result.json`，而是维护**控制层文件**（唯一逻辑写入者）：`workflow.json`、`events.jsonl`、`active-workflows.json`、`context-summary.md`、`rules-snapshot.md`、`tasks/`、`task-runs/`、`transactions/`、`dispatch/`、`decisions`（approval-request/response）、`gates/`（gate-result），以及工作流结束时的 `final-report.md`。它对每个工作 Agent 结果执行 §2/§4 校验与 Gate（见 `manager-orchestration.md`），并对工作 Agent 声明的 JSON / JSONL 输出再次执行 Ajv schema 校验。Runtime Guard 不调度工作 Agent；它按 manager 的显式请求执行 fail-closed 校验，用 `commit-transition` 原子持久化关键控制快照，并记录 manager 调用原生 session 工具前后的 dispatch 事实。终态 workflow 必须有非空 `final-report.md` 且已从 `active-workflows.json` 移除。

### 6.A requirement-agent（§16.A）

`requirements.md`、`scope.md`、`acceptance-criteria.json`、`assumptions.json`、`unresolved-questions.json`、`requirement-traceability.json`、`user-summary.md`、`manager-summary.md`、`result.json`。
- `acceptance-criteria.json` 以 `contracts/acceptance-criteria.schema.json` 为准：每条 `criteria[]` 含 `id`（`^AC-[0-9]{3,}$`）、`statement`、`verification_method`、`status ∈ PROPOSED/APPROVED/IMPLEMENTED/VERIFIED/FAILED/UNKNOWN`，可含 `priority ∈ MUST/SHOULD/COULD/WONT`。

### 6.B architect-agent（§16.B）

`architecture.md`、`project-structure.md`、`interfaces.md`、`data-model.md`、`threat-model.md`、`test-strategy.md`、`implementation-plan.json`、`risk-register.json`、`adr/ADR-*.md`、`architecture-traceability.json`、`user-summary.md`、`manager-summary.md`、`result.json`。
- 若为 HTTP API，生成实际适用的 OpenAPI 文件；**非 API 项目不得伪造 OpenAPI**。

### 6.C developer-agent（§16.C）

完整生产代码与必要配置、必要迁移与开发文档、`development-report.md`、`change-manifest.json`、`implementation-traceability.json`、`user-summary.md`、`manager-summary.md`、`result.json`，以及**真实本地 Git commit**。
- 所有修改只在被分配的绝对 worktree 内；不得声称代码可运行，除非实际执行过命令并保存真实日志。

### 6.D review-agent（§16.D）

`code-review.md` 或 `test-code-review.md`、`review-findings.json`、`security-review.md`、`dependency-license-review.md`、`review-traceability.json`、`user-summary.md`、`manager-summary.md`、`result.json`。
- `review-findings.json` 以 `contracts/review-findings.schema.json` 为准：`verdict ∈ APPROVE / REQUEST_CHANGES / BLOCKED`；每个 `findings[]` 含 `finding_id`（`^FIND-`）、`severity ∈ BLOCKER/CRITICAL/HIGH/MEDIUM/LOW/INFO`、`category`、`title`、`description`、`file`、`line`、`commit`、`evidence`、`remediation`、`blocking`、`status ∈ OPEN/RESOLVED/WONT_FIX/UNKNOWN/NOT_EXECUTED`。
- 顶层 `workflow_id` / `task_id` / `reviewed_commit` 必须绑定承载该文件的 `CODE_REVIEW` 或 `TEST_CODE_REVIEW` / `review-agent` task，且 `reviewed_commit == task.input_commit`。schema 不增加 `run_id`；run authority 来自文件所在的精确 current task snapshot `artifact_root_abs`、该 snapshot 的 `task_id` / `run_id` 和已验证 task event。每条 finding 的 `evidence` 只能引用同 task/run 的 `evidence.jsonl`。
- Gate 只聚合 current candidate 的 findings；同 candidate + `finding_id` 用 review task 的最后 event `seq` 选择唯一最新状态，允许后续 `RESOLVED` 覆盖旧 `OPEN`，歧义则 fail-closed。旧 candidate findings 只作历史记录。
- 默认只读；静态工具未装/未执行标 `UNKNOWN` 或 `NOT_EXECUTED`，不能用"看起来没问题"代替证据。

### 6.E test-agent（§16.E）

新增单元测试、新增集成测试、测试配置与 fixture、`test-plan.md`、`test-cases.json`、`test-report.md`、`coverage-report.json`（**仅当工具真实生成数据时**）、`test-traceability.json`、`command-records.jsonl`、原始 stdout/stderr 日志、`user-summary.md`、`manager-summary.md`、`result.json`，以及**真实本地 Git commit**。
- `test-report.md` 必须列出：命令、退出码、发现/成功/失败/跳过/错误数量、日志路径、哈希、重试、flaky、验收标准覆盖、`UNKNOWN` 项、是否修改生产代码。
- 每次测试记录 `isolation_mode=UNSANDBOXED_LOCAL`；未经授权不得改生产代码；不得自行宣布"测试通过"或"可发布"，只报告执行事实。第一次失败即使重试成功也**保留第一次失败**并标记潜在 flaky。

### 6.F release-agent（§16.F）

`release-decision.json`、`release-decision.md`、`release-notes.md`、`operations-handoff.md`、`deployment-prerequisites.md`、`rollback-plan.md`、`known-issues.md`、`artifact-manifest.json`、`build-verification.md`、`security-verification.md`、`checksums.sha256`、`user-summary.md`、`manager-summary.md`、`result.json`。
- `release-decision.json` 以 `contracts/release-decision.schema.json` 为准：必含 `workflow_id`、`task_id`、`run_id`、`candidate_commit`、`verdict ∈ GO / NO_GO / HOLD`、`checks[]` 与顶层 `evidence_refs`；每个 check 必含 `name`、`status ∈ PASS/FAIL/HOLD/UNKNOWN/NOT_APPLICABLE` 和非空 `evidence_refs`。这些 ID、candidate 与证据必须绑定承载该文件的 current `RELEASE_VERIFICATION` / `release-agent` task/run。
- verdict 由 checks 保守重算：任一 `HOLD` / `UNKNOWN` / `NOT_APPLICABLE` → `HOLD`；否则任一 `FAIL` → `NO_GO`；非空且全 `PASS` → `GO`；空 checks → `HOLD`。`GO` 仅代表 `READY_FOR_OPERATIONS_HANDOFF`（非已部署）。
- 缺关键证据不得给 `GO`（应 `HOLD`）；有失败测试/严重安全问题/无法验证的关键构建环节应 `NO_GO` 或 `HOLD`；不执行部署、不改生产环境、不访问生产凭证。

## 7. 命令记录与证据（配套产物字段）

- `command-records.jsonl`（`contracts/command-record.schema.json`）：每行含 `command_record_id`、`executable`、`cwd_abs`、`started_at`、`finished_at`、`exit_code`、`timed_out`、`stdout_path_abs`、`stderr_path_abs`、`attempt`、`invoked_by_agent`、`task_id`、`run_id`、`isolation_mode`（`UNSANDBOXED_LOCAL`）等；stdout/stderr 落盘为独立原始文件，重试生成**新**记录不覆盖失败。
- `evidence.jsonl`（`contracts/evidence.schema.json`）：每行含 `evidence_id`（`^EVD-`）、`source_type ∈ file/git/command/doc/user_input/config/other`、`locator_abs` 或 `git_locator`、`sha256`、`line_start`/`line_end`、`collected_at`、`collector`、`command_record_id`、`notes`。

## 8. 相关文档

`context-and-rule-passing.md`（上下文包与输入）、`manager-orchestration.md`（校验与 Gate）、`workflow.md`（各阶段产物时序）、`git-worktree-strategy.md`（commit 与 worktree）、`evidence-and-claims.md`（证据分类）。
