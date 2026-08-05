# 当前完成度评估

> 评估日期：2026-08-05
> 口径：框架代码与自动化验证、实际本机遗留迁移、OpenClaw 外部实机演练分开陈述。

## 结论

P0–P5 框架改造已完成：v2 当前状态已从多份可写 JSON 收束为 SQLite Control Kernel，workflow/task/dispatch/result 具备事务、CAS、哈希事件、幂等、outbox、审计和确定性投影恢复。7 个 Agent 的职责及 OpenClaw 原生调度方式保持不变。

这不等于生产运维能力全部完成。自动化 E2E 已覆盖完整 v2 状态路径和进程重启恢复，但尚未用真实 OpenClaw Gateway 重新跑一条全新的多 Agent 业务 workflow；部署、监控、告警、生产回滚仍明确不在本阶段范围内。

## 已验证

- 分支 `dev` 上 P0、P1、P2、P3、P4 各有独立 commit；P5 在最终收口。
- SQLite 是 v2 workflow/task/run/dispatch 唯一当前状态源；JSON/JSONL 是只读派生投影。
- workflow 命令、状态、事件、幂等结果和 projection outbox 同事务提交。
- task 必须通过上下文身份、输入哈希、依赖、Agent policy、绝对路径和 structured output 声明验证后才能派发。
- dispatch intent/task 状态/outbox 同事务提交；真实 session 用 `SENT → ACKNOWLEDGED → RUNNING` receipt 对账。
- result 与全部必需 JSON/JSONL 未通过 Schema、身份、路径和哈希校验时，task 不会成为 `COMPLETED`。
- audit 覆盖 SQLite integrity、workflow/task 哈希事件链、snapshot、run、dispatch/outbox、active view 和可选投影。
- 并发测试证明：同 workflow CAS 只有一个胜者；不同 workflow 不丢 active 状态；投影只确认实际读取的 revision。
- 崩溃测试覆盖提交前回滚、提交后响应丢失的幂等重放、投影失败恢复和 spawn 前重启保留 PENDING intent。
- 自动化完整 v2 workflow 可达 `READY_FOR_OPERATIONS_HANDOFF`；删除投影并重启数据库后可确定性恢复。
- `MIG-legacy-quarantine-20260805` 已对 4 个旧 workflow 完成 control/artifact tree 取证归档和 v2 tombstone 导入。旧目录未修改，旧 candidate 全部未信任。
- `WF-a899188b...` 被明确记录为：13 条现存事件内部哈希有效、snapshot revision 18、active index revision 7；未补造 revision 14–18。
- 当前既有 runtime 是 P0 前安装，`runtime-bundle.json` 尚不存在；源码与自动化安装验证已通过，但在真实启动新 workflow 前仍须重新执行安装同步并记录 bundle。本轮未擅自修改用户 OpenClaw 配置。

## 仍需实机验证

- 用已安装的 OpenClaw Gateway 创建一个全新 v2 workflow，真实调用 6 个工作 Agent，保存 session receipt 和 artifact，再完成所有 Gate。
- 在真实 Agent 正在运行时中断 manager/Gateway，重启后按 PENDING intent 查询原 session 并继续，而不是仅做自动化数据库夹具测试。
- 校验当前安装 runtime 的 agent bundle 与本分支源码一致；安装同步属于用户环境变更，应在执行前确认。
- 将 `test-agent` 从 `UNSANDBOXED_LOCAL` 迁移到真正隔离环境。

## 范围外

- 真实部署、生产凭证、监控告警、生产数据迁移、远程 Git、在线回滚。
- 多主机分布式控制。当前 SQLite 方案定位为本机单节点多 Agent 协作。
- LangGraph/StateGraph。当前没有引入；未来若增加动态图编排，只能把 Control Kernel 当持久化权威源，不能再创建第二套状态。

## 证据位置

- `scripts/control-kernel.mjs`、`scripts/control-core/`：v2 控制实现。
- `tests/control-kernel*.test.mjs`、`tests/task-repository.test.mjs`：事务、并发、崩溃、E2E 和恢复测试。
- `scripts/migrate-legacy-v1.mjs`、`docs/legacy-v1-migration.md`：遗留取证迁移。
- `runtime/control/control.db`、`runtime/control/v2/`：本机 v2 状态和只读投影（Git 忽略）。
- `runtime/control/legacy-archive/v1/MIG-legacy-quarantine-20260805/`：本机只读取证归档（Git 忽略）。
- `CHANGELOG.md`：P0–P5 每轮改动和验证记录。
