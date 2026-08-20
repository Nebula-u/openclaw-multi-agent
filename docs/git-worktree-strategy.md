# git-worktree-strategy.md — 本地 Git 与 worktree 策略

> 全程仅本地 Git。无远程、无网络。
> 权威来源：`agents/common/GIT_RULES.md`、`scripts/stategraph/git-worktree.mjs`（唯一实现）。
> 更新日期：2026-08-17（对齐 StateGraph + checkpointer 架构，替换旧三层架构下的分支/合并设计）

## 1. 本文用途

本文规定本项目的**本地 Git 隔离策略**：worktree 绝对路径位置、谁能改哪个 worktree、commit 信息格式、candidate 推进前的代码校验、破坏性/远程操作的禁止清单，以及非 Git 目录或存在未提交修改时的人工审批要求。当前实现只有 detached worktree + commit SHA 血缘校验，**没有分支创建或 Git merge 这一层**（见下文说明）。

## 2. Worktree 隔离方式（无分支）

`scripts/stategraph/git-worktree.mjs` 的 `prepare()` 用 `git worktree add --detach <path> <input_commit>` 为每个 task attempt 创建**游离头指针（detached HEAD）**worktree，不创建、不检出任何命名分支。`developer-agent` / `test-agent` 直接在该 detached worktree 上 commit；血缘关系通过 `assertCommit` / `assertDescendant`（`git merge-base --is-ancestor`）校验 `output_commit` 是否基于 `input_commit`，而不是通过分支。

> 若未来需要恢复分支命名（如 `sdlc/<workflow-id>/<task-id>/<agent-id>/attempt-<n>`），必须先在 `git-worktree.mjs` 中实现对应的 `checkout -b` 逻辑，再更新本文档；当前文档只描述已实现的行为。

## 3. worktree 绝对路径位置

worktree **必须**位于（绝对路径示例基于 `runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime`）：

```text
<ABS_RUNTIME_ROOT>\worktrees\<workflow-id-hash>\<task-id-hash>\<run-id-hash>\repo
```

代码创建示例（`git-worktree.mjs` 的 `prepare()` 实际执行的命令）：

```text
git -C "<target_project_root_abs>" worktree add --detach \
    "D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\<wf-hash>\<task-hash>\<run-hash>\repo" <input_commit>
```

> 实际目录名使用 workflow/task/run ID 的 SHA-256 短哈希（`pathKey()`），而非原始 ID 直接拼接，用于避免 Windows 路径过长导致 `'$GIT_DIR' too big` 错误。

路径规则（见 `agents/common/GIT_RULES.md` 第 7 节）：所有 Git 命令必须显式在目标项目绝对路径或绝对 worktree 中执行（`git -C "<abs>"` 或原生 Shell 工具的绝对 cwd）。**禁止依赖当前工作目录**，**禁止相对运行时路径**（如 `./repo`、`../worktree`、`workspace/task`）。即使从 `C:\Windows\System32` 启动也须正确解析。

## 4. 谁能改哪个 worktree

| 角色 | worktree 写权限 | 说明 |
|------|------------------|------|
| `developer-agent` / `test-agent` | 只能改**被分配的** worktree | 代码/测试修改必须形成**真实本地 commit** |
| `requirement` / `architect` / `review` / `release` | 默认**不改**业务仓库 | 正式报告写入 artifact，不为提交报告污染目标业务仓库；仅当任务明确要求更新业务仓库文档时才 commit |
| StateGraph 代码（`dispatch`/`reconcile` 节点） | 创建、校验 worktree；决定是否推进 candidate | 不改业务代码；只做 commit 存在性/血缘/身份校验，不执行 Git 合并 |

Git identity 只写入任务 worktree 对应仓库的**本地**配置，**不改全局** Git 配置。

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

`Input-Commit` 记录本次修改所基于的允许 input commit，供代码做 ancestry 校验与来源追溯。这是建议的 commit message 约定，当前代码不强制解析该 trailer，只依赖 `output_commit` 字段本身做校验。

## 6. candidate 推进校验（不是 Git merge）

`reconcile` 节点接收 DEVELOPMENT/TEST 结果时，`scripts/stategraph/git-worktree.mjs` 只做以下只读校验，**不执行任何 `git merge`**：

```text
git -C "<worktree>" cat-file -t <output_commit>                       # assertCommit
git -C "<worktree>" merge-base --is-ancestor <input_commit> <output_commit>  # assertDescendant
git -C "<worktree>" rev-parse --verify HEAD^{commit}                  # head，必须等于 output_commit
```

全部通过后，Gate 校验通过（必要时经人工审批），checkpoint 内的 `candidateCommit` 指针直接切换为该 `output_commit`——这是一次 checkpoint 状态更新，不是把该 commit 合并进目标仓库的某个分支。REVIEW/RELEASE 阶段读取的也是这个 checkpoint 指针，而不是某条合并后的分支。

失败 / 脏状态 / 未通过 Gate / 待审批的 worktree **默认保留**，不清理，供人工排查。

> 若未来需要把 candidate commit 真正合并回目标项目的某个分支，需要在 `git-worktree.mjs` 中新增合并逻辑并补充冲突处理策略，再更新本节；当前实现只到 checkpoint 指针层面。

## 7. 绝对禁止

- 连接远程仓库；执行 `push` / `pull` / `fetch` / 修改 `remote` / 远程 PR。
- 破坏用户数据的命令：`git reset --hard`、`git clean -fdx`、强制删除含未合并工作的分支/worktree。
- 修改**全局** Git 配置。

## 8. 需要人工审批的 Git 情况

由 StateGraph 代码生成审批节点并将 workflow condition 置 `WAITING_HUMAN`（见 `human-approval.md`）：

- **输入目录不是 Git 仓库** → **不**擅自 `git init`，请求审批（trigger `INPUT_NOT_GIT_REPO`）。
- **输入仓库存在未提交修改** → **不**自动 commit / stash / 丢弃 / 覆盖 / reset，请求用户选择处理方式（trigger `INPUT_DIRTY_WORKTREE`）。
- 任何破坏性、不可逆或可能影响其他项目的 Git 操作（trigger `DESTRUCTIVE_OR_CROSS_PROJECT`）。

**不设自动超时同意**，用户沉默 ≠ 批准。

## 9. 相关文档

`manager-orchestration.md`（路线与固定派发流程）、`architecture.md`（StateGraph 状态、checkpoint 与恢复）、`agent-contracts.md`（哪些角色需真实 commit）、`human-approval.md`（审批节点）。
