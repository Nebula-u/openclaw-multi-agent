# Git worktree、快照与回滚

## 目标

代码快照直接复用 Git，不在 SQLite 或 artifact 目录复制一份源码。Git object database 保存内容和历史；SQLite `snapshots` 保存 Agent、Session、task、execution、input/output commit 与变更摘要之间的索引。

这套方案的重量接近普通 Git 工作流：一个任务一个 detached worktree、一个已验证 commit、一个隐藏 ref。它不需要事件链、内容寻址副本服务或专用版本控制框架。

## 执行和验收

Orchestrator 为每个 task/attempt 创建隔离 worktree。Agent 可以在获准 worktree 中修改和正常提交，但不能创建快照记录或更新候选版本。

`COMPLETED` 结果必须通过宿主验证：

1. `input_commit` 和 `output_commit` 是完整 commit SHA；
2. output commit 存在；
3. output 是 input 的后代；
4. output 等于该 worktree 的 HEAD；
5. worktree clean；
6. 文件新增、修改、删除、重命名和 stat 由宿主 Git 重新计算。

通过后创建 `ACCEPTED` 或 `NO_CHANGE` snapshot，并用下列隐藏 ref 固定对象：

```text
refs/openclaw/snapshots/<snapshot-id>
```

非 `COMPLETED`、进程崩溃或脏 worktree 使用 recovery 路径。宿主会把未提交内容创建为 `FAILED_RECOVERY` commit 并固定 ref，但不会推进 `runs.candidate_commit`。这使失败现场可查看和恢复，同时不会把半成品当作已接受代码。

## 快照类型

| 类型 | 含义 | 推进 candidate |
| --- | --- | --- |
| `ACCEPTED` | 已验证且有代码变化 | 是 |
| `NO_CHANGE` | 输入与输出 commit 相同 | 成功结果可保持当前 candidate；恢复结果不推进 |
| `FAILED_RECOVERY` | 失败或未完成现场 | 否 |
| `RESTORE` | 从旧 snapshot 创建的新分支/worktree | 否 |
| `REVERT` | 在当前目标分支创建的反向 commit | 是 |

## 查看

```text
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --run-id RUN-...
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --task-id TASK-...
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --agent-id developer-agent --session-id SESSION-...
node scripts/orchestrator-cli.mjs snapshot-show --project-root . --snapshot-id SNP-...
node scripts/orchestrator-cli.mjs snapshot-diff --project-root . --snapshot-id SNP-...
```

历史 diff 从目标仓库读取，不依赖原 worktree 继续存在。

## Restore 与 Revert

Restore：

```text
node scripts/orchestrator-cli.mjs snapshot-restore --project-root . --snapshot-id SNP-...
```

它创建 `openclaw/restore/<new-snapshot-id>` 分支及 `runtime/restores/` 下的新 worktree，不修改当前分支。适合查看、继续开发或人工比较。

Revert：

```text
node scripts/orchestrator-cli.mjs snapshot-revert --project-root . --snapshot-id SNP-... --confirm SNP-...
```

它要求目标仓库 clean，并要求 `--confirm` 与 snapshot ID 完全一致。成功时使用 `git revert` 创建反向 commit；发生冲突会 abort 并返回 `SNAPSHOT_REVERT_CONFLICT`。系统不使用 `git reset --hard`，也不静默重写历史。

## 备份和保留

SQLite 索引本身不包含代码。完整备份必须同时覆盖：

- `runtime/control/kernel.db`；
- 目标 Git 仓库的 objects 和 `refs/openclaw/snapshots/*`；
- 需要保留的 `runtime/artifacts/`。

删除隐藏 ref 可能让不在普通分支上的 snapshot commit 被 Git GC。当前版本不自动清理 snapshot ref；制定保留策略前不要手动批量删除。

## 限制

- 仅跟踪 Git 仓库内的文件修改；数据库、外部服务或仓库外文件不属于代码快照。
- 一个 revert 对应一个 snapshot output commit；复杂 merge commit 或与后续修改冲突时需要人工处理。
- Git 仓库不可用时，SQLite 只能展示元数据，不能提供 diff 或恢复。
