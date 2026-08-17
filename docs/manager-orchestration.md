# Manager 与 StateGraph 编排协议

## Manager 的权限

`manager-agent` 负责理解用户请求、解释已验证事实并提出本轮动态路线。它不是 dispatcher、审批者或状态写入器。

Manager 可以：

- 读取代码提供的紧凑 checkpoint context；
- 输出符合 `route-plan.schema.json` 的路线提案；
- 说明风险、跳过理由和建议的阶段后审批点；
- 在新一轮路线修订时吸收人工意见。

Manager 不可以：

- 指定或调用 worker Agent；
- 修改 task、attempt、candidate、route hash 或 approval 状态；
- 使用 session 工具派发、催办或轮询；
- 代表用户批准路线或步骤；
- 把聊天文本、日志或自己的总结当作 checkpoint 事实。

## 路线生成

首次 bootstrap 后，StateGraph 创建固定的 `MANAGER_ANALYSIS -> manager-agent` task。Manager 输出只包含 request class、summary、risk flags、steps 和 skipped stages；Agent ID 由代码注入。

路线编译器会校验阶段顺序、跳过理由、request class、架构门槛、DEVELOPMENT/TEST 关系和审批门槛。通过后生成 `ROUTE_PLAN_CONFIRMATION`。人工确认前不派发任何 worker；确认后路线被冻结。

## 单步推进

每次 `node scripts/workflow.mjs run` 最多执行一个有界动作：

```text
initialize -> decide
  -> prepare_manager / prepare_step
  -> dispatch
  -> reconcile
  -> compile_plan / evaluate
  -> apply_human / complete / integrity_hold -> finish
```

调用返回的顶层 `condition` 为 `ACTIVE`、`WAITING_HUMAN`、`HOLD` 或 `TERMINAL` 时，调用方停止本轮（更细的进展原因见 `stop_reason`，如 `TASK_RUNNING`、`ROUTE_PLAN_FROZEN` 等）。monitor continuation 可以继续推进无人工阻塞的 workflow，但使用的仍是同一个 runtime capability 和 workflow lock。

## 固定派发

`config/stategraph-policy.json` 是 task kind 到 Agent ID 的代码策略。dispatch 会：

1. 从 checkpoint 读取 task 与 candidate。
2. 创建本 attempt 的 detached worktree。
3. 生成并验证 context manifest。
4. 为 TEST 准备并验证 Docker sandbox。
5. 使用代码生成的 Agent ID、session 和 message 调用 OpenClaw。
6. 保存 stdout、stderr、process result 和原始 JSON。

worker 无法通过输出修改下一 Agent 或路线。

## 结果与 candidate

reconcile 先重新验证 context manifest，再接收 `.agent-raw`。只有本地 ingestion 和 Gate 全部通过，task 才能成为 `ACCEPTED`。

- REQUIREMENTS/ARCHITECTURE/DESIGN/REVIEW/RELEASE 不得推进 candidate。
- DEVELOPMENT/TEST 必须返回真实 `output_commit`，并通过 ancestry 与 HEAD 校验。
- TEST 无代码变化时返回 `input_commit`；有测试代码变化时可提交新 commit。
- REVIEW/TEST/RELEASE 的输入始终来自 checkpoint 当前 candidate。

## 错误处理

- 非法 JSON：同一 session 最多重新生成 2 次。
- Agent 执行或 Gate 失败：新 attempt，最多 3 次。
- 重试不复用 worktree、run 或 session；失败 artifact 保留。
- 三次失败后生成绑定 task/route/candidate 的人工升级节点。
- 路线、事件链、candidate 或审批绑定不一致时进入 `HOLD`。

## Manager context 成本

Manager context window 为 200k，max output 为 32k，软输入预算按 `config/stategraph-policy.json` 的 `manager.soft_budget_percent`（当前 60%）动态计算得出，当前等于 120k，而非硬编码常量。实际 prompt 最多 12k 字符，默认只包含最近 8 个事件和 4 个错误摘要；原始日志不进入 prompt。Manager 不轮询运行中的 Agent。

## 恢复检查

新会话或进程重启后只需要：

```powershell
node scripts/workflow.mjs snapshot --project-root . --workflow-id WF-example
node scripts/workflow.mjs audit --project-root . --workflow-id WF-example
node scripts/workflow.mjs manager-context --project-root . --workflow-id WF-example
```

若 audit 失败，不得继续派发或审批；应保留数据库与 artifact，排查事件链或 checkpoint 漂移。
