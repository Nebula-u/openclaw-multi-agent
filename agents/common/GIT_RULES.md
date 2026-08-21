# GIT_RULES.md — 本地 Git 与 worktree 规则

> 版本: git-rules v1
> 全程仅本地 Git。无远程、无网络。

## 1. 绝对禁止

- 连接远程仓库；执行 `push` / `pull` / `fetch` / 修改 remote / 远程 PR。
- 破坏用户数据的命令：`git reset --hard`、`git clean -fdx`、强制删除分支/worktree 中未合并工作。
- 修改**全局** Git 配置。Git identity 只写入任务 worktree 对应仓库的**本地**配置。

## 2. 需要人工审批的 Git 情况

- 输入目录不是 Git 仓库 → **不**擅自 `git init`，请求审批。
- 输入仓库存在未提交修改 → **不**自动 commit/stash/丢弃/覆盖/reset，请求用户选择处理方式。

## 3. worktree 与快照

- 每个 task attempt 使用宿主创建的 detached worktree；Agent 不自行创建或切换分支。
- worktree 路径由宿主按 workflow/task/run 的哈希计算，并通过任务消息提供绝对路径。
- 宿主在完成后校验 commit、血缘、HEAD 和脏状态，并以 `refs/openclaw/snapshots/<snapshot-id>` 固定快照。
- 失败或未提交的修改由宿主形成 `FAILED_RECOVERY` 快照；Agent 不自行执行恢复。

## 4. 谁能改什么

- `developer-agent` / `test-agent`：只能修改被分配的 worktree，代码修改必须形成**真实本地 commit**。
- `requirement` / `architect` / `review` / `release`：正式报告默认写入 artifact，**不**为提交报告污染目标业务仓库；仅当任务明确要求更新业务仓库文档时才 commit。
- 工作 Agent **不得**合并或推进集成分支。Orchestrator 只在校验 `output_commit` 的存在性、ancestry、worktree HEAD 和 clean 状态后推进 Kernel 的 `candidate_commit`。

## 5. commit 信息格式

```
<agent-id>: <task-id> <简要说明>

Workflow-ID: <workflow-id>
Task-ID: <task-id>
Run-ID: <run-id>
Agent-ID: <agent-id>
Attempt: <n>
Input-Commit: <hash>
```

## 6. Orchestrator 候选提交规则

1. DEVELOPMENT/TEST 的 `output_commit` 必须是真实完整 SHA，等于该 run worktree HEAD，且为任务 `input_commit` 的后代。
2. REVIEW/TEST/RELEASE 只能从 Kernel 当前 `candidate_commit` 开始，不得自行切换候选版本。
3. 宿主从 Git 计算真实新增、修改、删除和重命名清单；Agent 自报文件列表不是权威。
4. 失败、脏状态、未接收或待审批的 worktree 与隐藏快照引用默认保留，用于取证和重试对比。
5. 恢复创建新分支/worktree；撤销使用 `git revert` 并要求人工确认；禁止重写历史。

## 7. cwd 规则

所有 Git 命令必须显式在目标项目绝对路径或绝对 worktree 中执行（`-C <abs>` 或原生 Shell 工具的绝对 cwd）。禁止依赖当前工作目录，禁止相对运行时路径（如 `./repo`、`../worktree`）。
