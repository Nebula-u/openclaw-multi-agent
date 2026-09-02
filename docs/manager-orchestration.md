# Manager 与 Orchestrator 协议

## Manager 权限

`manager-agent` 是唯一直接与用户交互的 Agent。它负责理解请求、解释路线和已验证结果、收集人工决定；它不是数据库写者、dispatcher 或审批者。

Manager 请求写入受管理 request queue，并绑定 `manager_session_id` 与 `manager_session_key`。Orchestrator 校验 `contracts/manager-request.schema.json`、目标 Git 根目录、路线顺序、跳过理由和固定 Agent 映射，再创建或修订 run。

Manager 不能指定任意 worker、直接调用其他 Agent、修改 task/attempt/candidate/snapshot、把自己的总结当作执行事实，或在用户没有明确选择时生成批准结果。它可通过固定的 `manager-control orchestrator-status` 读取自己绑定 workflow 的完整 pending approval，并通过 `orchestrator-approve` 生成同一绑定下的 DECISION request。

## 串行执行

1. Orchestrator 从 SQLite 读取 ACTIVE run 和当前 route step。
2. 按 task/attempt 创建 context manifest 与独立 detached worktree。
3. 获取该 task 的 execution lease。
4. 用固定 Agent ID 和确定性 Session ID 调用 OpenClaw，并在执行期间周期 heartbeat lease。
5. 校验并接收 result；JSON 契约失败时在同一 Session 内最多两次只重生成 JSON，不重新执行任务。
6. `COMPLETED` 走 accepted snapshot；其他状态走 recovery snapshot。
7. 成功则推进 candidate/route；需要人工决定则写 approval 和 Manager outbox；JSON 修复预算耗尽后才按 bounded task attempt 重试。

完整 task attempt 重试耗尽时，Orchestrator 创建 `TASK_RETRY_EXHAUSTED` 人工审批，选项包含 `RETRY_SAME_AGENT`、`ABORT` 和 `REWORK`。Manager 必须先用原 Session 绑定查询当前 pending approval，再在用户明确确认后提交原样 choice；Manager 不直接 dispatch、不解除 HOLD，也不自行重置重试计数。Monitor 使用同一审批事实与选项，因此两个入口不会产生不同语义。

前台服务：

```text
npm run orchestrator:start
npm run orchestrator:status
npm run orchestrator:stop
```

Monitor 不继续 workflow。HR 自动模式为 `off` 时，前台循环也不会运行 HR 队列。

前台服务和所有一次性 Kernel 写命令共用同一写者锁；前台运行时，另一个写命令返回 `WORKFLOW_LOCK_CONFLICT`。`status`、`kernel-status`、snapshot list/show/diff 保持只读，`stop` 仅写控制文件。

## 恢复

进程重启后直接从 SQLite runs/tasks/executions/approvals 恢复。到期 lease 与对应 RUNNING task 在同一 SQLite 事务中回收；失败现场通过 Git recovery snapshot 和 artifact 保留，下一 attempt 使用新 worktree。系统不依赖事件链重放，也不从 OpenClaw Session 推断 workflow 状态。

常用检查：

```text
node scripts/orchestrator-cli.mjs kernel-status --project-root .
node scripts/orchestrator-cli.mjs status --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --run-id RUN-...
```
