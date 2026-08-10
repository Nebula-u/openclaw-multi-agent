# Control Kernel v2

Control Kernel v2 是 manager-agent 与控制状态持久化之间的唯一确定性写入边界。它使用 Node.js 内置 SQLite，不启动数据库服务，也不调度工作 Agent。

## 权威边界

- manager 只提交符合 `contracts/transition-command.schema.json` 的动作命令，不提交自行计算的下一版快照。
- reducer 根据 `config/control-state-machine-v2.json` 计算下一状态。
- workflow 当前状态、命令幂等记录和不可变事件在同一个 SQLite `BEGIN IMMEDIATE` 事务内提交。
- `revision` 与事件 `seq` 每次成功命令只增加 1；失败命令不产生任何状态或事件。
- `command_id` 是幂等键：相同内容重放返回原结果，不同内容复用同一 ID 会失败关闭。
- 每个 workflow 固定 `contract_set_id`、`state_machine_version` 和 `agent_bundle_id`，历史记录不自动改用最新合同或 prompt。

## 状态模型

v2 将阶段和暂停/终结条件分离：

- `phase`：13 个 SDLC 阶段。
- `condition`：`ACTIVE`、`WAITING_HUMAN`、`HOLD`、`TERMINAL`。
- `outcome`：仅终态使用，包括运维交接、NO_GO、失败、取消和隔离。
- `resume_phase` / `resume_condition`：保存暂停前位置，避免从 HOLD 恢复时猜测目标状态。

## 当前命令

`BOOTSTRAP`、`ADVANCE_PHASE`、`WAIT_HUMAN`、`RESOLVE_HUMAN`、`HOLD`、`RESUME`、`SET_CANDIDATE`、`COMPLETE`、`FAIL`、`CANCEL`、`QUARANTINE`。

### 人工审批

`WAIT_HUMAN` 携带 `approval_request` 时，会在同一事务内将 workflow 置为
`condition=WAITING_HUMAN`，并写入 `approval_requests.status=PENDING`。审批请求绑定
`workflow_id/task_id/run_id`；它的 `PENDING` 不是第二套 workflow 状态。

只有 `RESOLVE_HUMAN` 携带通过 Schema 和绑定校验的真实 `approval_response` 才能将 workflow 恢复。
只要存在 PENDING request，直接 `RESUME` 就会返回 `CONTROL_APPROVAL_RESPONSE_REQUIRED`。有 task 绑定时，
`approval-resolve` 同时把 task 从 `WAITING_HUMAN` 恢复为 `READY`，之后才允许再次派发。

新 workflow 不使用旧文件协议中的
`WAITING_REQUIREMENT_APPROVAL`、`WAITING_ARCHITECTURE_APPROVAL`、`WAITING_RELEASE_APPROVAL` 等专用等待名称；
界面需要显示专用文案时，从 v2 `phase` 和审批 `trigger` 派生。

Demo 快速流程是 v2 的受控例外：只有已解决且选择 `DEMO_FAST` 的 `IMPLEMENTATION_TRADEOFF` 审批，
才允许 `INTAKE → DEVELOPMENT`；否则仍只能进入 `REQUIREMENTS` 标准路径。

## 只读投影与恢复

SQLite 是唯一当前状态源。`project` 在全局 projection lock 内从数据库生成：

- `runtime/control/v2/workflows/<workflow-id>/workflow.json`
- `runtime/control/v2/workflows/<workflow-id>/events.jsonl`
- `runtime/control/v2/active-workflows.json`

这些文件均标记为 `READ_ONLY_DERIVED`；丢失或篡改时由 `recover` 重建，不允许导入回数据库。每次状态事务会写 projection outbox，投影成功后置为 `APPLIED`。

`active_workflows` 是 SQLite view，只选择 `condition != TERMINAL` 的 workflow，不再维护第二份可写状态数组。`audit` 会重算事件哈希和前序链、核对事件数/revision、最后事件与当前状态、command/event 一一对应、active view 和可选投影内容。数据库审计失败时 `recover` 不猜测状态，只返回 `HOLD`；数据库一致而投影损坏时才允许重建投影。

## Task、派发与结果闭环

v2 task 也以 SQLite 为当前状态权威源。`task-register` 固定 workflow 的 `contract_set_id` 和 task 的
`output_contract_version`；`task-validate` 校验上下文身份、输入哈希、依赖、Agent/task 类型策略、绝对路径及
`structured_outputs` 契约后，才把 task 从 `CREATED` 推进到 `READY`。

派发明确采用 outbox 边界：

1. `dispatch-prepare` 在同一数据库事务内把 task 置为 `DISPATCHED`、保存不可变 intent，并写入 `dispatch_outbox=PENDING`。
2. manager 在事务成功后调用 OpenClaw `sessions_spawn`；Control Kernel 本身不调度 Agent。
3. `dispatch-receipt` 按 `SENT → ACKNOWLEDGED → RUNNING` 顺序记录真实 session ID；首份回执将 outbox 置为 `DELIVERED`。
4. 超时或进程崩溃时，PENDING intent 表示“查询外部 session 后对账”，不表示自动重试或自动 LOST。

`result-ingest` 要求 completion receipt 绑定同一 workflow/task/run/agent/attempt/session，并重新计算
`result.json` 哈希。它逐项读取 task 固定的 `structured_outputs`，使用 task 中固定的 Schema 路径校验 JSON/JSONL，
同时核对 result 身份、Agent、attempt、worktree 和 artifact 路径。任何必需输出缺失、为空或不合约时，数据库事务
不会开始，task 保持 `RUNNING`；只有验证过的 `result_status=COMPLETED` 才能提交 `task.status=COMPLETED`。

Task 当前快照、run 固定信息、不可变哈希事件、dispatch、outbox 与幂等 operation result 均在数据库中。
这没有改变各工作 Agent 的职责，只将 manager 原先分散的 task/dispatch/result 文件写入收束为一个确定性边界。

`audit` 同时核对 task JSON/列、run 固定信息、task event sequence/hash/from-to status、dispatch intent/receipt/completion
与 outbox。workflow 审计通过但 task/dispatch 漂移时，整体结果仍为 HOLD。

### Task CLI

- `task-register --task-file <abs>`
- `task-validate --task-id <id> [--occurred-at <ISO>]`
- `task-get --task-id <id>`
- `task-retry --task-file <new-attempt-task.json>`
- `dispatch-prepare --intent-file <abs>`
- `dispatch-receipt --receipt-file <abs>`
- `dispatch-list --task-id <id>` / `dispatch-outbox`
- `result-ingest --completion-file <abs>`
- `demo-fast-request --workflow-id <id>`
- `approval-request --request-file <abs>` / `approval-list [--workflow-id <id>]`
- `approval-resolve --response-file <abs>`

`task-retry` 只接受当前状态为 FAILED/LOST 且原 dispatch 有同状态 completion 的 task。它要求
attempt 递增、新 run ID、新 artifact root 和新 context manifest，保留 workflow/task/type/Agent/
max attempts/output contract 等不可变身份。旧 run、dispatch、artifact 和事件保留不覆盖；新 run
从 CREATED 开始，仍需重新 package validation 和 dispatch prepare。

## Snapshot 与监督事实

`snapshot [--workflow-id <id>]` 提供适合 Monitor 的一致性只读模型，按
workflow → task → dispatch 组合当前控制状态，并附带 supervision request。它不读取或信任
`runtime/control/v2/**` 投影，也不写数据库。

监督请求属于控制事实，保存在 `supervision_requests`、不可变 `supervision_events` 和
`manager_wake_outbox` 中。Watchdog 和本地用户只能创建 request；Wake Adapter 只能消费 wake
outbox；真正的 session 核查、NUDGE、completion reconciliation 和 retry review 仍由
manager-agent 执行。

监督 CLI：

- `supervision-request --request-file <abs>`
- `supervision-list [--status <status>]`
- `supervision-claim --claim-file <abs>`
- `supervision-complete --receipt-file <abs>`
- `supervision-events --request-id <id>`
- `wake-outbox`
- `wake-record --record-file <abs>`

请求、claim、完成和 wake receipt 都使用 operation/request 幂等键；相同内容重放返回原结果，
不同内容复用同一键失败关闭。`audit` 会验证 request scope、监督事件 sequence/hash、状态对应
事件和 wake outbox 一致性。

## 并发与故障语义

- 同 workflow 的并发命令使用 `expected_revision` CAS，只有一个事务成功；不同 workflow 共享数据库事务但不会覆盖 active view。
- 投影 outbox 以本轮读取的 revision 为高水位，导出期间的新 revision 保持 PENDING。
- 提交前故障回滚整个事务；提交后响应丢失由相同 command/operation ID 幂等重放。
- 投影失败将 outbox 标为 FAILED，权威数据库审计通过后可再次 `project/recover`。
- dispatch 提交后、spawn 前中断会留下单一 PENDING intent；恢复必须查询原 session，不能直接创建第二个 intent。

## StateGraph 适配

`scripts/workflow-runner.mjs` 在 Control Kernel 之上提供轻量 LangGraph `StateGraph` 执行层。Graph state 只包含当前 workflow/task 的有界执行上下文，不是权威快照，也不写入第二个 checkpointer。每轮从 SQLite 读取和审计，最多提交一个 workflow transition；合法性、CAS、幂等、审批和事件记录仍由本 Control Kernel 决定。
