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

## 3. 分支与 worktree 命名

- integration 分支：`sdlc/<workflow-id>/integration`
- 任务分支：`sdlc/<workflow-id>/<task-id>/<agent-id>/attempt-<n>`
- worktree 路径（绝对）：`<ABS_RUNTIME_ROOT>/worktrees/<workflow-id>/<task-id>/<run-id>/repo`

## 4. 谁能改什么

- `developer-agent` / `test-agent`：只能修改被分配的 worktree，代码修改必须形成**真实本地 commit**。
- `requirement` / `architect` / `review` / `release`：正式报告默认写入 artifact，**不**为提交报告污染目标业务仓库；仅当任务明确要求更新业务仓库文档时才 commit。
- 工作 Agent **不得**直接合并 integration 分支。合并由 manager-agent 负责。

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

## 6. manager-agent 合并规则

1. 合并前验证：commit 真实存在、ancestry（基于允许的 input commit）、diff、角色修改范围、worktree 状态。
2. 使用**非 fast-forward** merge（`--no-ff`），并记录来源分支、commit、Gate、task_id、run_id。
3. merge conflict **不**由 manager 猜测解决 → 重新分配给对应 developer/test-agent。
4. 失败 / 脏状态 / 未合并 / 待审批的 worktree **默认保留**，不清理。

## 7. cwd 规则

所有 Git 命令必须显式在目标项目绝对路径或绝对 worktree 中执行（`-C <abs>` 或原生 Shell 工具的绝对 cwd）。禁止依赖当前工作目录，禁止相对运行时路径（如 `./repo`、`../worktree`）。
