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

P1 只建立权威状态和事件事务。P2 将增加审计、恢复和只读 JSON/JSONL 投影；P3 再把 task、dispatch 与 Agent 结果摄取纳入相同边界。

