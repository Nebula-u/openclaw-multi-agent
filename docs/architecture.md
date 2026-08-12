# 总体架构：Control Kernel v2

> 文档日期：2026-08-12

## 核心结论

项目以 SQLite Control Kernel v2 作为 workflow、task、run、dispatch、审批和监督事实的唯一当前状态源。OpenClaw Agent 负责执行已分配任务；本地 Orchestrator 负责确定性派发和结果接收；Supervisor Core 负责 reconcile、续跑和 manager wake，公开的 Monitor HTTP 接口保持只读。

```text
OpenClaw Agent 层
  manager-agent ──> StateGraph Runner ──> Orchestrator ──> detached launcher ──> 工作 Agent
                         │                    │
                         └──────────┬─────────┘
                                    ▼
                  SQLite durable core
                    runtime/control/control.db
                 ┌──────────┴──────────┐
       workflow/task/dispatch facts   LangGraph checkpoints
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       只读 v2 投影           Supervisor Core / Dashboard
    runtime/control/v2/**       内部续跑 / 公开只读查询
```

StateGraph Runner 是轻量执行层，不建立第二个数据库。每轮先审计并读取业务事实，只执行一个有界动作；所有 workflow mutation 仍提交给固定 reducer，task 派发仍由本地 Orchestrator 完成。Graph checkpoint 和 pending writes 也落在同一个 `control.db`，以 `workflow_id` 作为 `thread_id`。Supervisor Core 在 durable launcher 结果出现后自动 reconcile，并连续执行有限个确定性 Graph turn；只在 `NEEDS_TASK`、`HOLD` 或 `FAILED` 等需要判断的位置唤醒 Manager。进程重启后先恢复 checkpoint，再以业务事实校正状态。

## 权威边界

- `runtime/control/control.db` 是 workflow/task/run/dispatch/approval 的唯一当前事实源。
- `langgraph_checkpoints` 与 `langgraph_checkpoint_writes` 只保存 Graph 续跑信息，不替代业务事实表。
- `config/control-state-machine-v2.json` 是新 workflow 的状态机；reducer 根据命令计算下一状态。
- `runtime/control/v2/**` 是数据库派生的只读投影，删除或漂移后可由 `recover` 重建，不能反向写回数据库。
- `active_workflows` 是 SQLite view，不再维护一份可写的活动数组。
- Agent 聊天消息、Markdown 总结和投影文件都不能单独推动状态；只有通过契约、身份、路径和哈希校验的控制命令或结果才能推进流程。

## 状态与人工审批

v2 将阶段和条件分开：

- `phase`：13 个 SDLC 阶段。
- `condition`：`ACTIVE`、`WAITING_HUMAN`、`HOLD`、`TERMINAL`。
- `outcome`：终态结果，如 `READY_FOR_OPERATIONS_HANDOFF`、`RELEASE_NO_GO`、`FAILED`、`CANCELLED`、`QUARANTINED`。
- `resume_phase` / `resume_condition`：保存暂停前位置。

人工审批通过 `WAIT_HUMAN` 创建绑定 workflow/task/run 的 `approval_requests` 记录，并将 workflow 置为 `condition=WAITING_HUMAN`。请求的 `status=PENDING` 是审批记录状态，不是第二套 workflow 状态。只有经过 Schema 和作用域校验的真实 `approval_response` 才能通过 `RESOLVE_HUMAN` 恢复；存在 PENDING request 时，直接 `RESUME` 会被拒绝。

Demo 快速流程是受控例外：只有已解决且选择 `DEMO_FAST` 的实现取舍审批，才允许 `INTAKE → DEVELOPMENT`；否则使用标准 `REQUIREMENTS` 路径。

## 任务、派发和结果

1. `task-register` 注册任务，固定 workflow 的 contract set 和任务输出契约版本。
2. `task-validate` 校验上下文身份、输入哈希、依赖、Agent 策略、路径和结构化输出声明，再把任务置为 `READY`。
3. `dispatch-prepare` 在事务中记录 intent、task 状态和 outbox；Orchestrator 随后调用真实 session 工具。
4. `dispatch-receipt` 记录真实 session 的 `SENT → ACKNOWLEDGED → RUNNING` 回执。
5. `result-ingest` 重新读取并校验 completion、result 及全部声明的 JSON/JSONL 产物，成功后才提交任务终态。

外部 session 创建无法与 SQLite 形成一个跨系统事务，因此 PENDING intent 必须通过真实 session 查询对账，不能靠猜测自动重试。

## 结构化产物校验

`scripts/runtime-guard.mjs` 保留稳定的 `validate-file` 和 `self-check` CLI，职责仅限当前 contracts/templates 的 Ajv 校验、JSONL 大小限制、重复证据 ID 检查和失败摘要脱敏。它不是状态机、数据库、dispatcher 或迁移器。

Control Kernel 的 `result-ingest` 还会按 task 固定的 `structured_outputs` 重新校验产物；Runtime Guard 的 Agent 自检不能替代这次入库前复核。

## 运行目录

```text
runtime/
├── control/
│   ├── control.db                         # 业务事实 + LangGraph checkpoint
│   ├── v2/                                # 可删除重建的只读投影
│   │   ├── active-workflows.json
│   │   └── workflows/<workflow-id>/{workflow.json,events.jsonl,projection.json}
│   ├── config-snapshots/                  # 安装配置备份
│   └── reinstall-backups/                # Agent 重装备份
├── artifacts/<workflow>/<task>/<run>/
└── worktrees/<workflow>/<task>/<run>/repo/
```

历史 v1 归档和备份仍保留在运行目录中，但不被新代码读取，也不属于新 workflow 的输入；本次清理不删除这些历史数据。

## Agent 职责

| Agent | 职责 |
|---|---|
| `manager-agent` | 与用户沟通、提交受控意图、处理审批和阶段编排；不直接写数据库或投影 |
| `requirement-agent` | 需求、范围、验收标准与追踪关系 |
| `architect-agent` | 架构、接口、风险、威胁模型和测试策略 |
| `developer-agent` | 在指定 worktree 中实现代码并提交真实 commit |
| `review-agent` | 对指定候选 commit 独立审查 |
| `test-agent` | 编写并真实执行测试，提交测试证据 |
| `release-agent` | 进行发布前验证并给出 GO/NO_GO/HOLD，不执行部署 |

只有 Orchestrator 可以创建工作 Agent session；工作 Agent 不得派生 Agent、修改控制状态或伪造回执。
