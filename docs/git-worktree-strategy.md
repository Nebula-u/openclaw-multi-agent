# git-worktree-strategy.md — 本地 Git 与 worktree 策略

> 全程仅本地 Git。无远程、无网络。
> 权威来源：`agents/common/GIT_RULES.md`、`agents/manager-agent/workspace/AGENTS.md`、重构 Prompt 第十四节。
> 文档日期：2026-07-23

## 1. 本文用途

本文规定本项目的**本地 Git 隔离策略**：分支命名、worktree 绝对路径位置、谁能改哪个 worktree、commit 信息格式、`manager-agent` 合并前校验与**非 fast-forward 合并**、破坏性/远程操作的禁止清单，以及非 Git 目录或存在未提交修改时的人工审批要求。这是三层架构中的 **C 层（本地 Git 隔离层）**。

## 2. 分支命名

- integration 分支：
  ```text
  sdlc/<workflow-id>/integration
  ```
  由 `manager-agent` 在 INTAKE 阶段基于 base commit 创建。
- 任务分支：
  ```text
  sdlc/<workflow-id>/<task-id>/<agent-id>/attempt-<n>
  ```
  每个 `developer` / `test` 任务（含每次重做 attempt）一条独立分支。

## 3. worktree 绝对路径位置

worktree **必须**位于（绝对路径示例基于 `runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime`）：

```text
<ABS_RUNTIME_ROOT>\worktrees\<workflow-id>\<task-id>\<run-id>\repo
```

创建示例（在目标业务项目绝对路径上操作）：

```text
git -C "D:\work\acme-service" worktree add -b sdlc/<wf>/<task>/<agent>/attempt-<n> \
    "D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\<wf>\<task>\<run>\repo" <input_commit>
```

路径规则（见 `GIT_RULES.md` 第 7 节）：所有 Git 命令必须显式在目标项目绝对路径或绝对 worktree 中执行（`git -C "<abs>"` 或原生 Shell 工具的绝对 cwd）。**禁止依赖当前工作目录**，**禁止相对运行时路径**（如 `./repo`、`../worktree`、`workspace/task`）。即使从 `C:\Windows\System32` 启动也须正确解析。

## 4. 谁能改哪个 worktree

| 角色 | worktree 写权限 | 说明 |
|------|------------------|------|
| `developer-agent` / `test-agent` | 只能改**被分配的** worktree | 代码/测试修改必须形成**真实本地 commit** |
| `requirement` / `architect` / `review` / `release` | 默认**不改**业务仓库 | 正式报告写入 artifact，不为提交报告污染目标业务仓库；仅当任务明确要求更新业务仓库文档时才 commit |
| `manager-agent` | 创建/校验/合并/决定是否清理 worktree | **不**替工作 Agent 写代码；**不**直接在 worktree 里改业务代码 |

工作 Agent **不得**直接合并 integration 分支；合并只由 `manager-agent` 负责。Git identity 只写入任务 worktree 对应仓库的**本地**配置，**不改全局** Git 配置。

## 5. commit 信息格式

`developer` / `test` 的每个 commit 必须遵循：

```text
<agent-id>: <task-id> <简要说明>

Workflow-ID: <workflow-id>
Task-ID: <task-id>
Run-ID: <run-id>
Agent-ID: <agent-id>
Attempt: <n>
Input-Commit: <hash>
```

`Input-Commit` 记录本次修改所基于的允许 input commit，供 `manager-agent` 做 ancestry 校验与来源追溯。

## 6. manager-agent 合并规则

1. **合并前校验**（与 `manager-orchestration.md` 第 5 节一致，任一失败不合并）：commit 真实存在、ancestry（基于允许的 input commit）、diff、角色修改范围（`allowed_write_paths_abs` / `forbidden_paths_abs`）、worktree 状态。
   ```text
   git -C "<worktree>" cat-file -t <output_commit>
   git -C "<worktree>" merge-base --is-ancestor <input_commit> <output_commit>
   git -C "<worktree>" diff --name-only <input_commit> <output_commit>
   git -C "<worktree>" status --porcelain
   ```
2. 使用**非 fast-forward** 合并（`--no-ff`），并在合并记录中记录来源分支、commit、Gate、`task_id`、`run_id`：
   ```text
   git -C "<target_abs>" merge --no-ff <task-branch> -m "manager: merge <task-id> run <run-id> (gate PASS)"
   ```
3. **merge conflict 不由 `manager-agent` 猜测解决** → 重新分配给对应 `developer-agent` / `test-agent`（新 attempt / run / worktree）。
4. 失败 / 脏状态 / 未合并 / 待审批的 worktree **默认保留**，不清理。

## 7. 绝对禁止

- 连接远程仓库；执行 `push` / `pull` / `fetch` / 修改 `remote` / 远程 PR。
- 破坏用户数据的命令：`git reset --hard`、`git clean -fdx`、强制删除含未合并工作的分支/worktree。
- 修改**全局** Git 配置。

## 8. 需要人工审批的 Git 情况

由 `manager-agent` 生成 `approval-request.json` 并将工作流置 `WAITING_HUMAN`（见 `human-approval.md` / `APPROVAL_RULES.md`）：

- **输入目录不是 Git 仓库** → **不**擅自 `git init`，请求审批（trigger `INPUT_NOT_GIT_REPO`）。
- **输入仓库存在未提交修改** → **不**自动 commit / stash / 丢弃 / 覆盖 / reset，请求用户选择处理方式（trigger `INPUT_DIRTY_WORKTREE`）。
- 任何破坏性、不可逆或可能影响其他项目的 Git 操作（trigger `DESTRUCTIVE_OR_CROSS_PROJECT`）。

**不设自动超时同意**，用户沉默 ≠ 批准。

## 9. 相关文档

`manager-orchestration.md`（合并前校验的完整清单）、`workflow.md`（各阶段的 commit/worktree 时序）、`state-and-recovery.md`（Git 与 workflow.json 一致性）、`agent-contracts.md`（哪些角色需真实 commit）、`human-approval.md`（审批节点）。
