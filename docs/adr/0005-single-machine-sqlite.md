# ADR 0005 · 单机 SQLite Control Kernel

- 状态：已接受
- 日期：2026-08-21
- 相关：`scripts/control-kernel/database.mjs`、`scripts/control-kernel/schema.sql`、`monitor/kernel-server.mjs`

## 背景

项目计划以单台服务器运行，用户并发通过同一 OpenClaw Gateway 进入，不需要多台机器共享控制面数据库。旧 PostgreSQL + StateGraph + 事件链结构带来了额外部署、迁移和双重事实来源成本。

## 决定

使用 Node.js 22.13+ 内置 `node:sqlite` 保存 Control Kernel 事实。默认路径为 `runtime/control/kernel.db`，只允许本机持久化磁盘。Orchestrator 是唯一常驻写者，Monitor 使用 `query_only` 连接。

新版本从空数据库开始，不迁移旧 PostgreSQL、LangGraph checkpoint、revision 或事件历史。schema 只保留八张当前业务表：runs、tasks、executions、artifacts、approvals、notifications、hr_jobs、snapshots。

数据库启用 WAL、foreign keys、busy timeout 与 `synchronous=FULL`。同一 task 只能存在一个活动 execution，由 SQLite 部分唯一索引保证；这只解决单机进程并发，不是分布式锁。

## 被抛弃的能力

- PostgreSQL 多机连接与集中式共享；
- LangGraph/StateGraph checkpoint 历史恢复；
- revision CAS；
- workflow event 表、事件哈希链和基于事件的审计重放；
- artifact CAS 源码副本。

当前场景中 OpenClaw 管理 Agent/Session，SQLite 记录结果事实，Git 记录代码变化，三者足以覆盖操作需求。若未来需要多主机 Orchestrator，应重新选择服务器数据库和分布式协调，不能把 SQLite 文件放到共享网络盘凑合使用。

## 后果

正面：部署只需要 Node、Git 和本地磁盘；测试不依赖外部数据库；状态模型更小；Monitor 可直接只读。

负面：不支持多机共享、数据库级 CDC/逻辑复制、旧历史迁移或事件重放。备份必须协调 SQLite、目标 Git 仓库与 artifact，而不是只备份一个数据库。
