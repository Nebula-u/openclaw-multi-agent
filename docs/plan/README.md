# docs/plan — Control Kernel + PostgreSQL 重构计划集

本目录是「引入 Control Kernel 作为唯一可信数据源、Checkpointer 迁移到 PostgreSQL、保留 Monitor 观测与 UI」这一次重构的**计划文档集**。

> 状态：**P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ · P5 ✅ · P6 ✅ · P7 ✅ · P8 ✅ · P9 ✅ · P10 ✅**。
> 分支 `workbuddy/control-kernel-postgres`，HEAD 以 Git 最新提交为准。
> **接手请先读 [`06-handoff-status.md`](./06-handoff-status.md)** —— 那是进度的唯一事实来源。

## 阅读顺序

| 序号 | 文档 | 内容 |
| --- | --- | --- |
| **0** | [`06-handoff-status.md`](./06-handoff-status.md) | **交接状态报告：已完成项、待修缺陷、后续阶段、环境准备、测试基线** ← 接手先读这份 |
| 1 | [`01-rollback-point-decision.md`](./01-rollback-point-decision.md) | git 回滚点分析与最终决策（含备选方案、必须保留的修复）— P0 已按此执行完毕 |
| 2 | [`02-target-architecture.md`](./02-target-architecture.md) | 目标分层架构、状态三分职责、写入顺序、流程与并行预留接口设计 |
| 3 | [`03-postgres-data-model.md`](./03-postgres-data-model.md) | PostgreSQL 数据模型（kernel schema + langgraph schema 完整 DDL）— §7 需按 06 §4.1 修订 |
| 4 | [`04-implementation-plan.md`](./04-implementation-plan.md) | P0–P10 分阶段实施计划与每阶段验证命令 — §P4 代码片段需按 06 §3.3 修正 |
| 5 | [`05-change-manifest.md`](./05-change-manifest.md) | 文件级新增/修改/删除清单、风险表、Agent 同步触发点、施工检查清单 |

## 一句话结论

- **回滚点**：不做 `git reset`。从当前 `49e9143` 新建分支 `workbuddy/control-kernel-postgres`，用一次显式提交删除已被取代的 `scripts/stategraph/webchat-bridge.mjs`，达到与回滚到 `7336b0a` 等价的架构干净度，同时保住 `8682934`（Windows worktree 路径哈希）与 `065fbab`（Monitor UI 静态托管）两处必须保留的修复。详见文档 1。
- **架构**：Control Kernel（PostgreSQL）持有 Execution 事实并且是唯一可信数据源；StateGraph + LangGraph Checkpointer（PostgreSQL）持有 Workflow 决策语义；Git + CAS 持有 Artifact。写入顺序恒为 **Kernel 先落库 → Checkpoint 后投影**。详见文档 2。
- **并行**：本次**不启用**并行 Agent，但 `split_tasks` / `merge_tasks` 两个直通节点、`task_group_id` / `parallel_slot` / `depends_on` 三个表字段、`policy.parallelism` 开关全部提前定型，打开开关即可扩展。详见文档 2 §7。
- **Monitor**：19 个 HTTP 端点、`publicWorkflow` / `publicTask` / `publicDispatch` 三个 read model 的字段名**全部冻结**，只做追加不做删改；数据源切到 Kernel 并保留 checkpoint 回退。详见文档 2 §8 与文档 4 P8。
- **运行时**：生产运行时要求 `OPENCLAW_PG_URL`；显式 `databasePath` 仅用于测试隔离的进程内 MemorySaver，不再创建 SQLite 文件。历史 `runtime/stategraph/checkpoints.db` 若仍被进程占用，应在停止相关进程后按文档 3 §8 归档。
- **语言**：Control Kernel 用 **JavaScript**，不引 Python。理由见文档 06 §8（同进程调用需求、哈希链跨语言一致性风险、`pg` 与官方 PG checkpointer 已够用、事务边界不可切断）。
