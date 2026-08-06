# architecture.md — Control Kernel v2 总体架构

> 项目：`openclaw-sdlc-multi-agent`
> 文档日期：2026-08-05

## 核心结论

系统没有 Python 控制平面，也没有第二个常驻 orchestrator。`manager-agent` 仍是唯一流程总控，并使用 OpenClaw 原生 `sessions_spawn` 调度原有 6 个工作 Agent。Node.js Control Kernel 负责确定性状态写入；宿主机原生 Supervisor Core 可常驻读取控制状态、采集遥测、执行健康分类和 Watchdog，但不调度工作 Agent、不执行 Git 合并，也不能成为第二个状态权威。

LangGraph/StateGraph 当前没有引入。现阶段的关键故障来自多文件写入和多份“当前状态”并存，SQLite 事务、CAS、不可变事件和 outbox 已直接解决这一层问题。若以后需要动态子图、长周期人工节点或跨进程调度，可在 Control Kernel 之上使用 LangGraph；图状态仍不得成为第二个权威状态源。

## 三层结构

```text
OpenClaw 原生 Agent 层
  manager-agent ── sessions_spawn/session receipt ──> 6 个工作 Agent
         │
         │ 动作命令、task、intent、receipt、completion
         ▼
Node.js Control Kernel（按需 CLI，不驻留、不调度）
  SQLite control.db
    workflows + immutable workflow_events + command idempotency
    tasks + task_runs + immutable task_events
    dispatches + dispatch_outbox + operation idempotency
  active_workflows SQL view + projection_outbox
         │
         ├──只读投影──> runtime/control/v2/**
         └──引用──────> artifact/input/output、Gate、审批、证据、日志
         │
         ▼
宿主机 Supervisor Core（可选常驻观察服务）
  monitor.db、activity、session tailer、health、Watchdog、SSE API
         │
         └──静态 HTML Dashboard / supervision request → manager 核查
         │
         ▼
本地 Git/worktree 层
  integration 分支 + 每任务独立 worktree；工作 Agent 按职责产出真实 commit
```

## 权威边界

- SQLite `<runtime>/control/control.db` 是 v2 workflow/task/run/dispatch 当前状态的唯一权威源。
- SQLite `<runtime>/monitor/monitor.db` 只保存可删除、可重建的 activity、session cursor、artifact metadata 和 health snapshot。
- Supervisor Core、Watchdog 和静态 Dashboard 都没有直接写 workflow/task 状态的权限；监督动作必须经过 request/outbox/receipt 和 manager 核查。
- manager 只提交命令或事实，不自行计算下一版 workflow 快照；reducer 根据版本化状态机计算状态。
- workflow state、不可变哈希事件、幂等 command result 和 projection outbox 在一个 `BEGIN IMMEDIATE` 事务内提交。
- task 注册固定 contract set/output contract version。`COMPLETED` 必须在 result 与全部必需结构化输出通过 Schema、身份、路径和哈希校验后提交。
- `active_workflows` 是 `condition != TERMINAL` 的 SQL view，不再人工维护第二份数组。
- `runtime/control/v2/**` 是 `READ_ONLY_DERIVED` 投影；丢失或篡改只能由通过数据库审计后的 `recover` 重建。
- 聊天文本不是状态源；Agent artifact 与 Git 是外部证据，必须验证后才能转成 Control Kernel 事实。

## 外部副作用与 outbox

SQLite 无法与 OpenClaw session 创建或 Git 操作形成跨系统原子事务，因此明确使用 intent/outbox/reconciliation：

1. 数据库先原子提交 dispatch intent、task `DISPATCHED` 和 `dispatch_outbox=PENDING`。
2. manager 再调用真实 `sessions_spawn`，显式传入 `agentId == assigned_agent`。
3. 真实返回后按 `SENT → ACKNOWLEDGED → RUNNING` 写 receipt；首份 receipt 将 outbox 标记为 `DELIVERED`。
4. 若在 1 和 2 之间崩溃，重启后 PENDING 表示“按 session key 查询并对账”，不表示自动重试或 LOST。
5. completion 与同一 session/run 绑定；重复提交以 record ID 幂等重放，不重复产生状态或副作用。

## 恢复与审计

`audit` 验证 SQLite integrity、workflow/task 事件序列和哈希、from/to lineage、command/event 对应、当前 snapshot、run、dispatch/outbox 与 active view；可选核对投影。数据库不一致时返回 HOLD，不从聊天或 JSON 投影猜测状态。数据库一致而投影缺失/漂移时，`recover` 确定性重建投影。

投影器使用读取高水位：只把本次实际读取的 revision 标为 `APPLIED`。导出期间并发产生的更新保持 `PENDING`，下一轮再投影，避免误确认未写入文件的新状态。

## 遗留 v1

旧 `runtime/control/workflows/**`、`active-workflows.json` 和基于 Runtime Guard `commit-transition` 的协议仅作遗留读取/取证用途。`migrate-legacy-v1.mjs` 哈希并只读归档原 control/artifact tree，在 v2 中只创建新的 `QUARANTINED` tombstone；不会补造缺失事件，也不会信任旧 candidate commit。详见 [legacy-v1-migration.md](legacy-v1-migration.md)。

Runtime Guard 继续负责 artifact、Gate、审批、Git 候选和遗留 v1 校验。它与 Control Kernel 都不是 Agent 调度器。

## Agent 职责

| Agent | 职责 |
|---|---|
| `manager-agent` | 唯一总控、用户交互、上下文/审批/Gate、原生 session 调度、结果复核、Git 合并 |
| `requirement-agent` | 需求与验收标准 |
| `architect-agent` | 架构、接口、威胁模型与测试策略 |
| `developer-agent` | 生产代码实现与本地 commit |
| `review-agent` | 独立代码/测试/安全审查 |
| `test-agent` | 测试实现和真实执行；当前 `UNSANDBOXED_LOCAL` |
| `release-agent` | 运维前发布候选 `GO/NO_GO/HOLD`；不部署 |

本次状态层调整没有合并或改变这些职责。只有 manager 能 spawn；工作 Agent 不得继续派生 Agent。

## 运行目录

```text
runtime/
├── control/
│   ├── control.db                         # v2 唯一当前状态源
│   ├── v2/                                # 可删除重建的只读投影
│   │   ├── active-workflows.json
│   │   └── workflows/<workflow-id>/{workflow.json,events.jsonl,projection.json}
│   ├── legacy-archive/v1/<migration-id>/  # 只读取证归档
│   ├── workflows/                         # 遗留 v1；禁止继续推进
│   └── install-manifest.json
├── artifacts/<workflow>/<task>/<run>/{input,output,raw-logs,checksums.sha256}
├── worktrees/<workflow>/<task>/<run>/repo/
└── agents/<agent-id>/{workspace,state}
```

## 范围与限制

- 只到运维前交付，不执行真实部署、远程 Git、生产迁移或在线回滚。
- `test-agent` 当前无 sandbox；路径、worktree、审批和证据校验不能替代真正的系统隔离。
- SQLite 适合本机单节点协作。若未来变成多主机高吞吐服务，应保留 reducer/command/event/outbox 语义并迁移到支持事务和行级并发的服务数据库。
