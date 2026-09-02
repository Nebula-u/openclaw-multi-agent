# ADR 0002 · 单库双 schema：kernel 存事实，langgraph 存决策

- 状态：已由 [ADR 0005](./0005-single-machine-sqlite.md) 取代
- 日期：2026-08-18
- 相关：`scripts/control-kernel/schema.sql`、`scripts/stategraph/postgres-checkpointer.mjs`、`monitor/telemetry-repository.mjs`

> 当前从空 SQLite 初始化，不运行 PostgreSQL 或 LangGraph checkpointer，也不迁移本文所述历史数据。

## 背景

重构前的状态分散在三处 SQLite：`runtime/control/control.db`（旧 Control Kernel）、`runtime/stategraph/checkpoints.db`（LangGraph checkpointer）、`runtime/monitor/monitor.db`（telemetry）。前两者都自称权威，崩溃恢复时无法判断以谁为准。需要决定新的存储切分。

## 备选方案

**A. 单库单 schema** —— Kernel 表与 checkpointer 表混在 `public`。

**B. 单库双 schema（选中）** —— 一个 PostgreSQL 实例，`kernel` schema 存事实，`langgraph` schema 存决策投影；telemetry 保持 SQLite。

**C. 双库** —— Kernel 与 checkpointer 各用独立数据库实例。

**D. 全量上 PG** —— 含 telemetry 一起迁入 PostgreSQL。

## 决定

采用方案 B：单 PostgreSQL 实例、两个 schema，telemetry 继续用 SQLite。

## 理由

**为什么单库**：写入顺序「Kernel 先落库 → Checkpoint 后投影」需要在同一连接/事务边界内保证。方案 C 的双库让这个顺序变成分布式事务问题，要么引入两阶段提交，要么接受不一致窗口——而这个顺序正是崩溃恢复能work的前提。

**为什么双 schema 而非单 schema**：两组表的所有权完全不同。`kernel.*` 由本项目的 `repository.mjs` / `lease.mjs` 独占写入；`langgraph.*` 由官方 `PostgresSaver` 的迁移脚本管理，表结构随上游版本变化（官方实现含 `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` / `checkpoint_migrations` 四表）。混在一个 schema 里，上游一次 migration 就可能与我们的表名撞车。分开后 `apply-schema.mjs` 只管 `kernel`，`checkpointer.setup()` 只管 `langgraph`，边界清晰。

**checkpointer 选官方包而非手写**：原计划是手写 `PostgresCheckpointSaver`（约 150 行）。裁决改为使用 `@langchain/langgraph-checkpoint-postgres` 的 `PostgresSaver`，子类 `KernelPostgresSaver` 只补一个本项目自定义的 `threadIds()` 方法。理由是官方包接受外部 `pg.Pool`（可与 Kernel 共用连接池，这正是写入顺序所需），且 serde 与迁移跟随上游修复。代价是 `schema.sql` 不再定义 langgraph 段——表结构由 `setup()` 建，我们不做对照表（方案 C 式的「两套表结构并存」被明确排除）。

**为什么 telemetry 不上 PG**：
1. telemetry 是**可丢弃的观测数据**，不是可信数据源。丢了重新 tail session 文件就能重建。
2. Monitor 必须能在 PG 挂掉时独立运行并展示降级状态（见 ADR 0004）。若 telemetry 也在 PG，PG 一挂 Monitor 连自己的健康分类都写不了。
3. 迁移它没有收益，只增加 PG 的写压力和一个新的失败点。

这是明确的设计决定，不是遗漏——后续接手者不要「顺手统一一下」。

## 后果

**正面**：单实例部署；Kernel 与 Checkpointer 共用连接池并保证写入顺序；上游 checkpointer 升级不影响 kernel 表。

**负面**：所有 Kernel SQL 使用裸表名，依赖连接上的 `search_path`。这带来一个已踩过的坑：`pool.query()` 每次随机取连接，单次 `SET search_path` 只对一条连接生效。必须在 `createKernelPool()` 的 `connect` 事件上设置，测试 fixture 同构。相关代码不得改回 `pool.query('SET ...')`。

**负面**：`kernel.mjs` 中的 SQL 不能硬编码 `kernel.` 前缀，否则测试用的临时 schema（`kernel_t_<hex>`）会失败。已统一为裸表名。
