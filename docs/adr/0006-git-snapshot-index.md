# ADR 0006 · Git 保存代码快照，SQLite 只存索引

- 状态：已接受
- 日期：2026-08-21
- 相关：`scripts/orchestrator/git-worktree.mjs`、`scripts/orchestrator/snapshot-service.mjs`、`docs/git-worktree-strategy.md`

## 背景

需要像 Codex/GitHub 一样知道每个 Agent 修改了什么，并能直接查看、恢复或撤销。仅保存 Session 输出不能证明真实文件变化；复制每份源码到 artifact CAS 又会形成第二套版本控制和保留策略。

## 决定

复用目标项目 Git object database 作为唯一代码快照存储。每个 Agent task 使用独立 detached worktree。宿主验证 output commit 的存在性、血缘、HEAD 和 clean 状态，并用 Git 自行计算文件变化。

SQLite `snapshots` 只保存索引及小型 change summary。每个 snapshot 使用 `refs/openclaw/snapshots/<id>` 固定 commit，防止 detached 对象被垃圾回收。失败或脏 worktree 创建 recovery commit，但不推进 candidate。

Restore 创建新的 `openclaw/restore/*` 分支和 worktree；Revert 需要精确确认并创建反向 commit。禁止用 `reset --hard` 实现用户回滚。

## 取舍

保留：真实 diff、逐 Agent/Session 归属、失败现场、历史可追踪的反向 commit、独立恢复分支。

不实现：数据库保存 patch/源码副本、事件链证明、跨仓库事务回滚、仓库外副作用回滚。

## 后果

完整灾备必须同时保存 SQLite 索引和目标 Git 仓库。原任务 worktree 可以清理，因为历史 diff 从目标仓库及隐藏 ref 读取。若删除 snapshot ref，未被普通分支引用的对象可能被 Git GC，因此当前不自动清理这些 ref。
