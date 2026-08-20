# Context Manifest 与规则传递

每个 Agent attempt 由宿主代码生成不可变 `context-manifest.json`。它是该 run 的输入清单，不是可写 workflow 状态。

## 清单内容

- workflow/task/run/Agent/attempt；
- target repository、worktree 和 artifact root；
- input commit 与 route hash；
- Agent 永久规则和共享规则副本；
- task 输入文件、角色和 SHA-256；
- 预期 raw output 路径；
- Manager session reference（仅 Manager task）。

manifest 本身的 SHA 写入 checkpoint、task 和 launcher。dispatch 前、reconcile 前都会重新计算。

## 路径规则

输入必须存在、为普通非 symlink 文件，并位于代码允许的来源。worktree 路径由代码根据 workflow/task/run 计算，不能由 Agent提供。

Agent 允许写入：授权 worktree、`.agent-raw`、runner raw logs。规则副本、manifest、`/input` 和最终 output 都不可由 Agent 修改。

## Docker staging

TEST 会把 manifest 和输入复制到只读 `/input`，并将容器可见路径改写为 `/worktree`、`/agent-raw` 等。原主机路径保存在 `host_path_metadata`，用于 result/CommandRecord 身份字段和本地校验。

## 漂移处理

任何 manifest、规则副本或输入 SHA 变化都返回 `CONTEXT_*` 错误并消耗当前 task attempt。失败 run/worktree/artifact 默认保留，下一 attempt 使用全新清单。

## Manager context

Manager 不接收完整 manifest 历史。宿主从 checkpoint 生成最多 12k 字符的紧凑 context，实际字段为 `request`（用户原始请求）、`route_plan`、`active_task`、`pending_approval`、`recent_events`、`recent_error_reports` 和 `session_policy`（不含独立的 `candidate` 字段，candidate commit 相关信息通过 `active_task`/checkpoint 隐含体现）；原始文件通过 locator 留在 artifact。
