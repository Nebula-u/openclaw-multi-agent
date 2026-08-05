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

`BOOTSTRAP`、`ADVANCE_PHASE`、`WAIT_HUMAN`、`HOLD`、`RESUME`、`SET_CANDIDATE`、`COMPLETE`、`FAIL`、`CANCEL`、`QUARANTINE`。

## 只读投影与恢复

SQLite 是唯一当前状态源。`project` 在全局 projection lock 内从数据库生成：

- `runtime/control/v2/workflows/<workflow-id>/workflow.json`
- `runtime/control/v2/workflows/<workflow-id>/events.jsonl`
- `runtime/control/v2/active-workflows.json`

这些文件均标记为 `READ_ONLY_DERIVED`；丢失或篡改时由 `recover` 重建，不允许导入回数据库。每次状态事务会写 projection outbox，投影成功后置为 `APPLIED`。

`active_workflows` 是 SQLite view，只选择 `condition != TERMINAL` 的 workflow，不再维护第二份可写状态数组。`audit` 会重算事件哈希和前序链、核对事件数/revision、最后事件与当前状态、command/event 一一对应、active view 和可选投影内容。数据库审计失败时 `recover` 不猜测状态，只返回 `HOLD`；数据库一致而投影损坏时才允许重建投影。

P3 将把 task、dispatch 与 Agent 结果摄取纳入相同边界。
