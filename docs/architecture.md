# Orchestrator、SQLite、Git 与 OpenClaw 架构

## 权威边界

| 信息 | 权威来源 |
| --- | --- |
| workflow/task/execution/approval/notification/HR 状态 | `runtime/control/kernel.db` |
| 代码版本、差异、恢复与撤销 | 目标项目 Git object database |
| Agent 对话、thinking/reasoning、最终回复 | OpenClaw Agent Session |
| result/evidence/log 等文件 | `runtime/artifacts/` + SHA-256 |
| UI 游标、健康和 SSE 缓存 | `runtime/monitor/monitor.db`，可重建 |

SQLite 不保存完整源文件或 patch；`snapshots` 只把 Agent、Session、execution 和 Git commit 关联起来。OpenClaw Session 不推进 workflow，也不能替代 Git 文件快照。

## 组件

```text
User
  │
Manager Agent native Session
  │ CREATE / CHANGE / DECISION request
  ▼
Orchestrator ───────────────┐
  │                         │ openclaw agent --agent --session-id
  │                         ▼
  │                   Worker Agent Session
  │                         │ result + Git commit
  │                         ▼
  ├─ SQLite Kernel      host validation
  ├─ Artifact store     Git snapshot ref
  └─ Manager outbox         │
                            └─ optional HR Session review

Monitor: SQLite read-only + redacted Session reader + telemetry SQLite
```

## SQLite Control Kernel

事实库固定为单机本地磁盘。默认路径：

```text
runtime/control/kernel.db
```

八张表：

- `runs`：冻结路线、当前步骤、候选 commit、Manager Session 绑定；
- `tasks`：任务角色、attempt、输入 commit、状态和结果定位；
- `executions`：worker、lease、heartbeat、Agent/Session/worktree；
- `artifacts`：文件路径、SHA-256、commit 关联；
- `approvals`：待处理和已解决的用户决定；
- `notifications`：Manager outbox；
- `hr_jobs`：Session 审查队列和输出；
- `snapshots`：Git 快照索引。

数据库启用 WAL、外键、busy timeout 和 `synchronous=FULL`。一个 task 同时只能存在一个 `LEASED`/`RUNNING` execution，由部分唯一索引保证。所有 Kernel 写入口共用一个进程锁，保证任一时刻最多一个写进程；前台 Orchestrator 运行时，一次性写 CLI 会失败关闭。Monitor 和只读 CLI 使用 `query_only` 连接且不会初始化缺失数据库。SQLite 不承担多主机协调。

不存在 `events` 表、revision CAS、事件哈希链或审计重放。状态变化直接写对应事实表；需要通知用户的动作同时写通知 outbox。

## 路线执行

1. Manager 在原始会话中确认用户意图，写入 schema-valid request。
2. Orchestrator 校验 Session 绑定、路线结构、角色映射和目标 Git 仓库。
3. `runs` 冻结路线和基线 commit。
4. 每个步骤按 task/attempt 创建独立 artifact root、不可变 context manifest 和 detached worktree。
5. Orchestrator 使用确定性 Session ID 调用指定 Agent。
6. 宿主校验 result JSON、身份、路径、manifest SHA 和 Git commit。
7. 通过后记录 snapshot 并推进候选 commit；失败则保留 recovery snapshot。
8. 路线配置要求人工审批时，写 `approvals` 和 Manager notification；Manager 在原始 Session 收集用户决定。

Worker 之间不直接通信，不读写 Kernel，不修改路线、审批、快照引用或 Monitor。

## Git 快照

每个 accepted snapshot 必须满足：output commit 存在、为 input 后代、等于 HEAD、worktree clean。宿主通过 Git 计算 name-status/stat，创建：

```text
refs/openclaw/snapshots/<snapshot-id>
```

该引用防止 detached commit 被垃圾回收。失败或脏工作区由宿主创建 recovery commit，但不会推进 `runs.candidate_commit`。只有 Developer/Test 可以改变目标仓库，其他 Agent 的成功快照必须是 `NO_CHANGE`。

恢复有两种语义：

- Restore：从目标 commit 创建 `openclaw/restore/*` 分支和新 worktree；
- Revert：仅对当前 HEAD 的祖先 snapshot，在明确确认后创建反向 commit，冲突时停止。

不使用 `git reset --hard`，不静默改写历史。

Git commit/ref 与 SQLite snapshot/candidate 不能组成跨资源 ACID 事务。实现只做局部补偿：索引失败删除本次 hidden ref，Restore 失败清理新 worktree/分支；Revert 已产生的反向 commit 永不自动抹除，而是返回 commit SHA 供对账。备份必须同时覆盖 SQLite、目标 Git 和 artifacts。

## HR 审查

HR Agent 默认手动调用。范围按 snapshot 对应的 Agent Session 划分，每次只接收：

- thinking/reasoning 块；
- 最后一条 assistant 输出；
- Git 变更摘要和受限长度文本 patch（二进制只保留摘要/stat）；
- 最小 workflow/task/execution/attempt 及任务角色、目标和 mutation policy。

输入先脱敏，排除用户全文、system prompt、工具参数和工具输出。HR 只检查越权、边界不清晰、猜测/模糊结果；不能改变 workflow、批准结果、调用其他 Agent 或联系用户。

自动模式 `off/task/daily/both` 只是同一入队与执行接口的调度策略，默认 `off`。snapshot + source Session 跨触发方式去重；日期按 UTC 校验。HR 输出必须通过 OpenClaw envelope 和三类 finding 的结构校验，非法输出只失败 HR job。

## Monitor

Monitor 打开 Kernel 的只读连接，读取 workflow、task、execution、notification、approval、HR 和 snapshot。Session tailer 只向 UI 提供脱敏可见文本；HR dossier 由显式 HR 命令或启用的自动策略单独生成。

Monitor 不运行 HR、不执行 restore/revert、不重试通知、不修复 Kernel。它不公开 dossier、`hr_jobs.input` 或 HR 原始 Session，只展示校验后的 findings。它自己的 telemetry SQLite 可删除重建。

## 崩溃恢复

- Orchestrator 重启后从 Kernel 读取 ACTIVE/HOLD/WAITING_HUMAN 状态。
- 活跃 Agent 由周期 heartbeat 续租；心跳所有权丢失会中止执行。到期 execution lease 和对应 RUNNING task 在同一 SQLite 事务中分别标为 `LEASE_EXPIRED`/`FAILED`，任务按 bounded retry 规则用新 attempt worktree 重试。
- Agent 进程失败或 result 不可信时，worktree 和 recovery snapshot 保留。
- Manager 通知失败留在 outbox，由 Orchestrator CLI 重试。
- Monitor 故障或 telemetry 丢失不改变 workflow。

## 不支持

- 多台机器共享一个 SQLite 文件；
- 多个 Orchestrator 常驻写者；
- 从 PostgreSQL/StateGraph 导入历史 workflow；
- 以 Session 回放替代 Git 回滚；
- Monitor 直接修改业务状态。
