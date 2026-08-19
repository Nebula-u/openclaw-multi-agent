# ADR 0003 · 并发闸门用 PostgreSQL 部分唯一索引做 lease 仲裁

- 状态：已接受
- 日期：2026-08-18
- 相关：`scripts/control-kernel/lease.mjs`、`scripts/control-kernel/schema.sql`、`config/stategraph-policy.json`

## 背景

需要保证「同一个 task 同时只有一个活跃 Agent 执行」，并且要能识别静默死掉的 Agent 进程。重构前没有任何机制：Agent 进程崩溃后 workflow 会永久卡在 RUNNING，只能人工介入。

## 备选方案

**A. 应用层内存锁** —— 单进程内用 Map 记录活跃 task。

**B. Redis 分布式锁** —— `SET NX PX` + 续期。

**C. PostgreSQL 部分唯一索引 + lease（选中）** —— 索引保证唯一性，`lease_expires_at` 列 + 心跳保证活性。

**D. PostgreSQL advisory lock** —— `pg_advisory_lock(task_hash)`。

## 决定

采用方案 C：

```sql
CREATE UNIQUE INDEX executions_active_lease
  ON executions(task_id) WHERE state IN ('LEASED','RUNNING');
```

`acquireLease` 用单条 `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` 实现；冲突（`rowCount === 0`）时再查持有者并抛 `{ code:'LEASE_HELD', details:{ active_execution_id, worker_id } }`。

## 理由

**排除 A**：内存锁在进程重启后丢失，且无法表达「进程已死但 task 仍标记 RUNNING」这个状态。它解决的是并发问题，不是活性问题，而我们两个都要解决。

**排除 B**：串行单 worker 下 Redis 没有职责——lease 仲裁 PG 能做且更可靠（事务保证），事件分发已有进程内 `MonitorEventHub`。引入 Redis 只增加一个运维组件和一个失败点。多 worker 跨进程时再引入，届时 `MonitorEventHub` 换成 Redis pub/sub 即可，Kernel 接口不变。

**排除 D**：advisory lock 与连接生命周期绑定，连接断开锁自动释放——听起来方便，实际上意味着「lease 状态不可查询、不可审计、不可跨进程接管」。我们需要的恰恰是一份**持久的、可查询的**执行事实：谁在跑、什么时候开始的、心跳到哪了。

**选 C 的关键设计点**：

1. **索引建在 `(task_id)` 而非 `(run_id)`**。即「一个 task 一个活跃 execution，一个 run 可以有多个」。串行由 StateGraph 只产生一个 active task 保证，不是靠数据库约束。这样打开并行开关时数据库层零改动——**串行是并行的退化情形，不是特例分支**。

2. **单条 SQL 完成检查+插入**。不能先 `SELECT` 再 `INSERT`：两者之间存在竞态窗口。`ON CONFLICT DO NOTHING` 让数据库在索引层原子判定。

3. **`lease_seconds > heartbeat_interval_seconds * 2` 是硬断言**（`POLICY_LEASE_TOO_SHORT`）。租约必须能容忍至少两次心跳丢失才判过期，否则网络抖动或 GC 停顿会误杀活着的 Agent。当前配置 120s / 30s，容忍 3 次丢失。这个约束在 `loadStateGraphPolicy()` 里 fail-closed 校验，不是文档建议。

4. **心跳返回 `null` 即自杀**。`lease.heartbeat()` 返回 `null` 表示租约已被 reaper 回收，`agent-runner` 必须立即终止子进程。语义明确，无歧义分支。

5. **回收由 Monitor 周期驱动**。`reconcileCycle()` 每周期调 `reapExpiredLeases()`，把过期 execution 标记 `LEASE_EXPIRED`。PG 不可达时只记降级、不中断刷新（见 ADR 0004）。

## 后果

**正面**：Agent 进程静默死掉会被 lease 超时兜住，`reconcile` 产生 `LEASE_EXPIRED` 分支走正常 attempt 重试预算，不再永久卡死。lease 状态可查询、可审计。

**正面**：并行扩展时数据层与 lease API 都不需要改。

**负面**：新增一条 `dispatch` 失败路径 `LEASE_HELD`。串行下不会触发，但接口必须在——否则并行扩展时要动核心调度逻辑。已复用现有 `SANDBOX_GLOBAL_BUSY` 的处理路径（记事件、`stopReason='DISPATCH_DEFERRED'`、不消耗 attempt）。

**负面**：lease 配置从「环境变量 `OPENCLAW_KERNEL_LEASE_SECONDS`」改为「policy 优先、环境变量兜底」。`config/stategraph-policy.json` 的 `lease_seconds` / `heartbeat_interval_seconds` 现在真正流到 kernel 与 agent-runner，改配置会实际生效——这在重构前是死配置。
