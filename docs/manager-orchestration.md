# Manager 与 Orchestrator 协议

## Manager 权限

`manager-agent` 是唯一直接与用户交互的 Agent。它负责理解请求、解释路线和已验证结果、收集人工决定；它不是数据库写者、dispatcher 或审批者。

Manager 请求写入受管理 request queue，并绑定 `manager_session_id` 与 `manager_session_key`。Orchestrator 校验 `contracts/manager-request.schema.json`、目标 Git 根目录、路线顺序、跳过理由和固定 Agent 映射，再创建或修订 run。

Manager 不能指定任意 worker、直接调用其他 Agent、修改 task/attempt/candidate/snapshot、把自己的总结当作执行事实，或在用户没有明确选择时生成批准结果。

## 串行执行

1. Orchestrator 从 SQLite 读取 ACTIVE run 和当前 route step。
2. 创建 task、context manifest 与 detached worktree。
3. 获取该 task 的 execution lease。
4. 用固定 Agent ID 和确定性 Session ID 调用 OpenClaw。
5. 校验并接收 result。
6. `COMPLETED` 走 accepted snapshot；其他状态走 recovery snapshot。
7. 成功则推进 candidate/route；需要人工决定则写 approval 和 Manager outbox；失败按 bounded attempt 重试。

前台服务：

```text
npm run orchestrator:start
npm run orchestrator:status
npm run orchestrator:stop
```

Monitor 不继续 workflow。HR 自动模式为 `off` 时，前台循环也不会运行 HR 队列。

## 恢复

进程重启后直接从 SQLite runs/tasks/executions/approvals 恢复。到期 lease 会被回收；失败现场通过 Git recovery snapshot 和 artifact 保留。系统不依赖事件链重放，也不从 OpenClaw Session 推断 workflow 状态。

常用检查：

```text
node scripts/orchestrator-cli.mjs kernel-status --project-root .
node scripts/orchestrator-cli.mjs status --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --run-id RUN-...
```
