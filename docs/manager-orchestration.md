# Manager 编排协议（v2）

> 权威状态与命令说明见 [control-kernel-v2.md](control-kernel-v2.md)。
> 本文只描述新 workflow；旧文件型 workflow 文档已归档。

## 1. 总原则

`manager-agent` 是流程总控和用户交互者，但不是状态数据库写入器，也不是 Agent dispatcher。它只能提交 Control Kernel 命令、准备 task/intent/receipt/completion 事实，并根据返回结果决定下一步。

- 不读取聊天文本作为状态事实。
- 不直接写 `control.db`、v2 投影或任务终态。
- 不调用原生跨 Agent session 工具；由本地 Orchestrator 统一派发。
- 不在人工审批时自行代替用户选择；用户沉默不等于批准。
- 任一校验失败都停止推进，等待修复、审批或明确失败处理。

## 2. Intake 与快速 Demo

收到用户请求后，Manager 先通过 Control Kernel 建立 workflow，并确认目标项目路径、Git 状态、策略、Agent bundle 和 contract set。

标准路径：

```text
BOOTSTRAP → INTAKE → REQUIREMENTS → REQUIREMENT_GATE → ARCHITECTURE → …
```

Demo 快速路径不是默认路径。Manager 必须先提交 `WAIT_HUMAN`，在审批请求中明确 `IMPLEMENTATION_TRADEOFF` 和 `DEMO_FAST` 选项；只有用户通过真实交互返回、Control Kernel 将审批置为已解决后，才可提交 `INTAKE → DEVELOPMENT` 的 `ADVANCE_PHASE`。

审批请求必须包含：

- `workflow_id`，必要时包含 `task_id` / `run_id`；
- 清晰的影响范围、风险、候选选项和推荐选项；
- `decision_id`、审批触发器和可验证的响应范围。

请求写入数据库后，Manager 必须向用户展示实际待审批内容并等待明确回复。不能只在 Agent 内部生成“请审批”的文本，也不能用 Manager 自己生成的 APPROVED 文件恢复流程。

## 3. 任务注册与派发

每个任务都遵循以下顺序：

1. `task-register`：固定 workflow、任务类型、Agent、attempt、artifact root 和输出契约。
2. `task-validate`：验证上下文包、规则快照、依赖、绝对路径、worktree 和 `structured_outputs`。
3. `dispatch-prepare`：事务化记录派发 intent，并将 task 置为 `DISPATCHED`，写入 outbox。
4. 本地 Orchestrator 从 READY task 固定派生 `agentId`、session key 和 intent，不接受 Agent 自选目标。
5. `dispatch` 只启动独立的本地 Agent runner，持久化 launcher/status/stdout/stderr/result locator，并立即返回 `STARTED`；Windows 由 runner 显式调用 `ComSpec`/`openclaw.cmd`，不使用同步 `shell:true`；它不等待长时间 Agent 进程。
6. `dispatch-reconcile --dispatch-id <id>` 或下一轮 `workflow-run` 只对账原 dispatch，按 `SENT → ACKNOWLEDGED → RUNNING` 记录真实生命周期，然后摄取结果。
7. Agent 只能写入 `artifact_root/.agent-raw/**`；Orchestrator 负责摄取、清洗、Schema 校验和原子发布。

当前 Agent 执行策略由 `config/agent-execution-policy.json` 固定：Agent 进程超时、dispatch lease、Agent 工具运行宽限期及 Agent 契约测试调用均不得超过 900 秒。Manager 唤醒和健康检测仍使用更短的独立上限，以便监工及时发现状态变化；配置或命令行显式传入超过对应上限的值时直接拒绝，不自动放宽。

PENDING dispatch intent 或 `DISPATCHED/RUNNING` task 代表需要查询原 launcher/session 后对账，不代表可以无条件重派。若是旧版 dispatch 且没有 launcher locator，`dispatch-reconcile` 只返回 `RECOVERY_REQUIRED`，不会根据聊天记录或残留产物伪造 completion；必须重新建立新的受控 run。即使用户批准应急恢复，也只能调用 `dispatch-reconcile`，不能直接调用 `openclaw.cmd` 或手工写 SQLite。

## 4. 结果接收与阶段推进

Manager 收到完成通知后，必须从 artifact 重新读取结果，而不是信任消息内容：

- completion 必须绑定同一 workflow/task/run/agent/attempt/session；
- `result.json`、evidence、command records 及任务声明的所有结构化产物必须通过 Schema、路径和哈希校验；
- Git commit、diff 范围、worktree 状态和命令证据必须与 task 一致；
- 仅在 `result-ingest` 成功后，才根据 Gate 和 Control Kernel 结果推进下一阶段。

Control Kernel 负责计算 `phase + condition + outcome`，Manager 不自行计算 revision、事件链或恢复目标。

## 5. 审批、HOLD 与恢复

需要用户决定时：

1. 提交 `WAIT_HUMAN` 和完整 `approval_request`。
2. 确认 workflow 为 `condition=WAITING_HUMAN`，task（如有）为 `WAITING_HUMAN`。
3. 通过应用层真实交互向用户展示请求，等待用户返回具体选择。
4. 将用户响应转换为绑定的 `approval_response`，提交 `RESOLVE_HUMAN`。
5. 只有数据库返回已解决且状态恢复为 `ACTIVE` / `READY` 后，才继续派发或推进。

一致性、权限、工具或证据问题使用 `HOLD`，不能伪装成审批已通过。存在 PENDING approval request 时，直接 `RESUME` 会被 Control Kernel 拒绝。

## 6. 会话恢复与完成自检

新 Manager 会话先查询：

```powershell
node scripts/orchestrator.mjs manager-context --project-root . --workflow-id <WF-...> --estimated-tokens <n>
node scripts/orchestrator.mjs dispatch-reconcile --project-root . --dispatch-id <DSP-...>
node scripts/control-kernel.mjs snapshot --project-root . --workflow-id <WF-...> --view manager
node scripts/control-kernel.mjs audit --project-root .
node scripts/control-kernel.mjs approval-list --project-root . --status PENDING
node scripts/control-kernel.mjs dispatch-outbox --project-root .
```

`--view manager` 是面向 Manager 的紧凑只读上下文：只包含当前 workflow、活动 task、待审批、待处理 dispatch 和最新事件；历史 task、完整 dispatch receipt、completion payload、raw log 与历史事件必须按需通过 artifact/evidence 引用读取，不得默认注入 Manager 会话。

`manager-context` 将静态会话预算与紧凑 snapshot 合并为一次确定性读取。达到 120k soft budget 时返回 `START_NEW_MANAGER_SESSION`；新会话只使用返回的 `prompt_context` 和必要 artifact locator 恢复，不复制旧聊天历史。调用方暂时无法提供 token 估算时返回 `MEASURE_CONTEXT`，不得据此假定预算充足。Manager 用户可见输出采用 summary-only 协议，不展示逐工具进度、源码探查、session 尾部或模型思考。

按 audit 结果处理：

- 数据库一致、投影损坏：执行 `recover` 重建只读投影；
- PENDING dispatch：查询真实 session 后由 Orchestrator 对账；
- PENDING approval：向用户展示并等待真实响应；
- 数据库审计失败：保持 HOLD，不从投影、聊天或历史文件猜测恢复。

宣布完成前必须确认：结果、Gate、release decision、审批、Git 候选、task/dispatch/outbox 和 Control Kernel audit 均一致；最终状态只能由 `COMPLETE`、`FAIL`、`CANCEL` 等受控命令产生。

## 7. StateGraph 执行层

Manager 可以通过以下命令请求本地 StateGraph 执行一个有界编排轮次：

```powershell
node scripts/orchestrator.mjs workflow-run --project-root . --workflow-id <workflow-id>
```

调用方若已保存上次观察到的 Control Kernel `revision`，可追加 `--after-revision <n>`。当数据库没有比该 revision 更新的事实时，Runner 返回 `WAITING_FOR_CHANGE`，不会启动本轮 Graph；这只是事件/修订版本保护，不改变任何合法边，也不替代正常 StateGraph 路由。

StateGraph 根据 Control DB 的 `phase + condition` 路由，复用现有 task validation、dispatch、result ingestion 和 transition command。动态路由依次经过安全守卫、结构化结果分类、阶段策略、状态机合法边校验和命令构建五层；五层共享同一轮读取的事实，不产生额外持久状态。它不会创建缺少上下文的 task package：当前阶段没有已注册 task 时返回 `NEEDS_TASK`；审批、HOLD、运行中 task 和终态均立即停止。失败分诊只有在结构化结果给出精确合法阶段，或调用方显式传入 `--target-phase` 时才推进。

五层路由的最后一步只生成 Control Kernel command intent，不直接写状态。`repository.apply()` 仍负责 revision/CAS、reducer 合法性、事务、事件链和幂等。

Graph 不使用独立持久化 checkpointer。命令 CAS、task operation 幂等、dispatch outbox、事件链和 workflow lock 共同承担并发与恢复边界。

## 8. 相关文档

- [architecture.md](architecture.md)
- [control-kernel-v2.md](control-kernel-v2.md)
- [agent-contracts.md](agent-contracts.md)
- [gate-checklists.md](gate-checklists.md)
- [human-approval.md](human-approval.md)
- [git-worktree-strategy.md](git-worktree-strategy.md)
