# 多 Agent 实时看板与监督执行机制实施计划（Control Kernel v2）

> 版本：2.0
> 更新日期：2026-08-05
> 状态：待评审、待实施
> 适用项目：`openclaw-multi-agent`
> 参考项目：`D:\MicroConnect\project\edict-main`
> 替换说明：本文完整替换 2026-08-04 的旧版可观测性计划。旧计划以可写
> `workflow.json`、`task.json` 和 `active-workflows.json` 为主要事实源；当前项目已经升级为
> SQLite Control Kernel v2，因此旧方案的数据源、写入边界、命令闭环和恢复策略均已失效。

## 1. 文档目的

本文解决两个相互关联、但必须分开设计的问题：

1. **看板问题**：如何实时、准确、安全地看到 workflow、task、run、dispatch、session 和
   Agent 的当前状态、进展、产物、阻塞与父子关系。
2. **监督问题**：如何发现 Agent 未启动、长时间无进展、会话失联或超过租约，并在不重复
   spawn、不绕过 Gate、不破坏审计链的前提下进行催办、核查、重试和人工升级。

本计划的核心结论是：

> 保留 `control.db` 作为唯一控制状态权威；新增只读 Monitor、独立可重建遥测库、SSE
> Dashboard，以及“Watchdog 创建监督请求 → 唤醒 manager-agent → manager 核验并执行”
> 的监督闭环。

Monitor 不成为第二个编排器，Watchdog 不直接控制工作 Agent，网页也不直接修改 workflow
或 task 状态。

## 2. 为什么必须替换旧计划

旧计划形成于项目迁移到 Control Kernel v2 之前，主要假设是：

- `runtime/control/active-workflows.json` 是活动工作流索引。
- `runtime/control/workflows/<workflow-id>/workflow.json` 是当前 workflow 快照。
- `tasks/*.json` 和 `events.jsonl` 是看板的直接事实源。
- Monitor 可以通过扫描这些文件构造状态。

当前项目已经明确：

- `<runtime>/control/control.db` 是 workflow、task、run 和 dispatch 当前状态的唯一权威源。
- `runtime/control/v2/**` 只是只读派生投影，不能反向导入数据库。
- workflow 状态、不可变事件、command 幂等结果和 projection outbox 在同一 SQLite 事务中提交。
- dispatch 必须遵循 intent/outbox、真实 `sessions_spawn`、receipt 和 reconciliation 顺序。
- Control Kernel 不调度 Agent，manager-agent 仍是唯一编排者。

如果继续按旧计划实现，将产生以下问题：

1. 重新引入第二份“当前状态”。
2. 看板可能把延迟或损坏的投影误认为真实状态。
3. 网页命令可能绕过 Control Kernel reducer 和审计。
4. Watchdog 可能在原 session 仍存活时重复 spawn。
5. 旧文件路径与当前 v2 runtime 布局不一致。

因此，本计划从数据读取、事件协议、监督动作到恢复顺序全部按 Control Kernel v2 重写。

## 3. edict-main 代码学习结论

### 3.1 管理 Agent 如何推动下级 Agent

`edict-main` 的管理链路不是单纯依赖一个总管 Agent 定时思考，而是由角色协议和后台调度器
共同完成。

角色链路如下：

```text
太子
  └─ 中书省：整理需求、起草方案
       └─ 门下省：审议、准奏或封驳
            └─ 尚书省：确定执行部门并派发
                 └─ 六部 Agent：实际执行
```

关键机制：

1. 中书省被明确要求不能在门下省准奏后结束，必须调用尚书省。
2. 尚书省调用一个或多个六部 subagent，等待结果并汇总。
3. 六部作为 subagent 完成后自动返回父 Agent，不自行寻找上级会话。
4. 每个角色在回复前执行防卡住检查，确认下游是否已调用、结果是否已回收。
5. 门下审议最多三轮，防止中书省和门下省无限往返。

这种机制解决的是“管理 Agent 不得过早宣布完成”和“下级结果必须回到调用者”两个问题。

### 3.2 强制进展上报

所有 Agent 都被要求通过统一 CLI 上报：

```text
create    创建任务
state     更新状态
flow      记录部门/Agent 流转
progress  上报当前动作和计划清单
todo      更新子任务及产出详情
done      提交完成结果
block     标记阻塞
```

其设计重点包括：

- `progress` 与任务状态分离，避免一次普通进展上报误推进流程。
- 每个关键阶段都必须有 `progress`。
- Todo 同一时刻最多一个 `in-progress`。
- Todo 未全部完成时拒绝 `done`。
- 状态转换由 `_VALID_TRANSITIONS` 校验。
- 高风险转换进入 `PendingConfirm`。
- 所有动作写入 audit log。
- 多 Agent 并发更新通过原子文件更新和文件锁保护。

### 3.3 真正的主动催办机制

主动监督主要由 `dashboard/server.py` 中的常驻调度线程完成，而不是由管理 Agent 自己定时运行。

调度器执行：

1. 定期扫描所有非终态任务。
2. 根据 `lastProgressAt` 计算停滞时间。
3. 首先重新派发当前阶段对应 Agent。
4. 重试耗尽后升级给门下省、尚书省协调。
5. 继续失败时尝试回滚到历史快照。
6. 连续回滚失败后标记 `Blocked` 并要求人工介入。

Agent 唤醒最终通过类似以下命令完成：

```text
openclaw agent --agent <agent-id> -m <message> --timeout <seconds>
```

因此，edict-main 的主动监督本质上是：

```text
定时扫描 → 停滞检测 → 再次发消息/派发 → 逐级升级 → 人工介入
```

### 3.4 看板如何实现

当前轻量看板链路为：

```text
Agent
  ↓ kanban_update.py
tasks_source.json / audit_log.json
  ↓ refresh_live_data.py
live_status.json
  ↓ dashboard/server.py HTTP API
React Dashboard（5 秒轮询）
```

看板包含：

- 流程阶段条。
- 任务卡片。
- 当前状态、当前部门、当前进展。
- Todo/checkpoint。
- `flow_log` 与 `progress_log` 时间线。
- Agent 在线、休眠和最后活跃时间。
- 心跳与停滞标记。
- 手动叫停、取消、恢复、推进、重试、升级和回滚。
- 任务详情、会话活动和工具输出摘要。

`edict-main` 还包含一套 FastAPI、Postgres、Redis Streams、Outbox Relay、WebSocket 和 worker
的重型事件驱动实现。该实现适合多进程和更大规模部署，但不适合直接作为当前项目第一期
依赖。

### 3.5 值得借鉴的部分

| edict-main 做法 | 当前项目的采用方式 |
|---|---|
| 管理 Agent 有明确的下游完成条件 | manager 增加监督请求处理和完成前检查 |
| 统一 progress/todo/flow 协议 | 新增结构化 activity/checkpoint 协议 |
| 状态和进展分开 | 控制状态留在 `control.db`，活动进入遥测层 |
| 多证据判断 Agent 活跃度 | 综合 task、dispatch、lease、session、activity、artifact |
| 任务卡片、流程条、时间线和详情抽屉 | 作为 Dashboard 的核心页面结构 |
| 手动重试、升级和叫停 | 转换为 manager 执行的监督请求 |
| 事件 topic/trace/producer/payload | 形成统一 Monitor Event Envelope |
| Outbox 避免双写 | 监督请求和 manager 唤醒也使用 outbox |

### 3.6 不应照搬的部分

1. 不复制 JSON 文件作为当前状态源。
2. 不让 Monitor 直接调用工作 Agent。
3. 不让网页直接修改 task/workflow。
4. 不自动恢复历史状态快照。
5. 不按单一 `updatedAt` 判断 Agent 是否停滞。
6. 不展示完整 thinking 或 chain-of-thought。
7. 不在原 dispatch 未确认终结时重复 spawn。
8. 不在第一期引入 Redis、Postgres 和多 worker 部署。

特别需要避免 edict-main 中的以下问题：

- 提示词中的“24 小时审计”与代码中的分钟级阈值不一致。
- `progress` 更新时间与 scheduler 的 `lastProgressAt` 可能不一致。
- 每次扫描都可能继续提升 retry/escalation，缺少充分冷却窗口。
- 自动回滚可能绕过状态机、Gate、审批或外部副作用事实。
- 进程在线只能说明 Agent 可能存在，不能证明任务仍在推进。

## 4. 当前项目能力与差距

### 4.1 已有能力

当前项目已经具备：

- SQLite `control.db` 单一权威状态。
- workflow phase、condition 和 outcome 分离。
- workflow command 幂等和不可变哈希事件。
- task、task run 和 task event。
- dispatch intent、outbox、receipt、completion receipt。
- `PREPARED → SENT → ACKNOWLEDGED → RUNNING` 派发链路。
- session key、session ID、lease deadline、retry count 和 max retries。
- result 与结构化产物的 Schema、身份、路径和哈希校验。
- Control Kernel audit、recover 和只读 projection。
- manager-agent 唯一调度者边界。
- Runtime Guard 的 Gate、审批、证据和 Git 校验。

### 4.2 当前缺口

- 没有常驻 Monitor 服务。
- 没有浏览器看板。
- 没有显式 activity、heartbeat 和 checkpoint 契约。
- 没有安全的 session JSONL 实时尾读器。
- 没有 Agent 健康投影和停滞置信度。
- 没有常驻 Watchdog 消费 lease 和活动信号。
- 没有持久化的监督请求、监督事件和监督回执。
- 没有可靠机制在 manager 会话休眠时将其唤醒。
- 没有用户从看板发起催办、暂停、核查或升级的闭环。
- 当前 Control Kernel 查询接口偏命令行，不足以支持持续 Dashboard 快照。

## 5. 设计原则与不可破坏边界

### 5.1 单一事实源

- `control.db` 是 workflow、task、run、dispatch 和监督请求的唯一权威源。
- `runtime/control/v2/**` 只是只读投影。
- `monitor.db` 只保存可以从控制库、session 和 artifact 重建的遥测数据。
- Dashboard 状态不能反向写回控制快照。

### 5.2 唯一编排者

- manager-agent 仍是唯一可以 spawn 工作 Agent、向工作 Agent 下达控制消息、决定 retry 或推进
  workflow 的角色。
- Watchdog 只能创建监督请求。
- Manager Wake Adapter 只能唤醒 manager-agent，不能直接唤醒工作 Agent。
- Monitor 不能调用 `sessions_spawn`、不能写 completion receipt、不能改变 Gate。

### 5.3 外部副作用必须可对账

- 催办、发消息、暂停、重试都先有 durable request/outbox。
- 执行后必须有 receipt。
- manager 或服务重启时先查原 session，再决定是否重发。
- lease 过期只表示“必须核查”，不等于 session 已丢失。

### 5.4 安全与隐私

- 不采集完整 thinking。
- 不向浏览器暴露 system prompt、完整上下文和未截断日志。
- 所有文本先脱敏、再截断、再推送。
- 浏览器只接收 `USER_SAFE` 或 `INTERNAL_SUMMARY` 内容。
- Monitor 默认仅监听 `127.0.0.1`。

### 5.5 故障隔离

- Monitor 停止时，原 workflow 继续运行。
- Watchdog 停止时，只丢失自动催办，不破坏控制状态。
- 遥测损坏时重新构建，不从遥测库修复 `control.db`。
- 控制库 audit 失败时，监督动作全部失败关闭。

## 6. 目标总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                     OpenClaw Runtime                         │
│ manager-agent ── sessions_spawn/sessions_send ── worker      │
│       │                                      │               │
│       └──────── session/completion facts ────┘               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                 ┌─────────▼─────────┐
                 │ Control Kernel v2 │
                 │ control.db        │
                 │ workflow/task/run │
                 │ dispatch/outbox   │
                 │ supervision       │
                 └─────────┬─────────┘
                           │ read-only snapshot/change cursor
       ┌───────────────────┼──────────────────────────┐
       │                   │                          │
┌──────▼────────┐  ┌───────▼────────┐       ┌────────▼─────────┐
│ Activity API  │  │ Session Tailer │       │ Artifact Watcher │
│ explicit emit │  │ safe fallback  │       │ output/raw-logs  │
└──────┬────────┘  └───────┬────────┘       └────────┬─────────┘
       └───────────────────┼──────────────────────────┘
                           ▼
                 ┌───────────────────┐
                 │ Monitor Service   │
                 │ monitor.db        │
                 │ snapshot/projector│
                 │ health classifier │
                 │ SSE event hub     │
                 └──────┬───────┬────┘
                        │       │
                        │       ▼
                        │  Supervisor Watchdog
                        │       │ supervision request
                        │       ▼
                        │  Manager Wake Adapter
                        │       │ only wakes manager
                        │       ▼
                        │  manager verifies and acts
                        ▼
                 Web Dashboard
```

## 7. 权威数据模型扩展

### 7.1 `supervision_requests`

该表保存所有人工或自动监督请求，是控制事实，不放入 `monitor.db`。

建议字段：

```text
request_id              SUP-<uuid>
idempotency_key         workflow/task/run/type/window
workflow_id
task_id
run_id
dispatch_id
target_agent_id
request_type            NUDGE | RECONCILE | RETRY_REVIEW |
                        PAUSE_REQUEST | RESUME_REQUEST |
                        CANCEL_REQUEST | ESCALATE
source                  WATCHDOG | LOCAL_USER | MANAGER
reason
evidence_json
status                  REQUESTED | CLAIMED | EXECUTING |
                        SUCCEEDED | FAILED | CANCELLED
requested_at
claimed_by
claimed_at
completed_at
result_code
result_summary
attempt
```

约束：

- `idempotency_key` 唯一。
- workflow/task/run/dispatch 必须存在且互相一致。
- 终态请求不可重新执行。
- 自动请求必须记录触发阈值和完整证据摘要。
- 监督请求不能直接改变 task 状态。

### 7.2 `supervision_events`

追加式记录：

```text
REQUEST_CREATED
REQUEST_CLAIMED
MANAGER_WAKE_QUEUED
MANAGER_WAKE_SENT
SESSION_CHECKED
NUDGE_SENT
NUDGE_ACKNOWLEDGED
RETRY_APPROVED
RETRY_REJECTED
ESCALATED
REQUEST_COMPLETED
REQUEST_FAILED
```

事件需要 sequence、previous hash 和 event hash，审计方式与现有 task event 一致。

### 7.3 `manager_wake_outbox`

用于解决“数据库已生成监督请求，但唤醒 manager 的外部调用失败”问题。

```text
wake_id
request_id
status          PENDING | DELIVERED | FAILED
attempts
next_attempt_at
last_error
created_at
delivered_at
manager_session_key
```

Manager Wake Adapter 必须按 outbox 重试；响应不确定时，先按 session key 查询，不直接重复调用。

### 7.4 Control Kernel 新命令

建议新增：

```text
snapshot
supervision-request
supervision-list
supervision-claim
supervision-complete
supervision-events
wake-outbox
```

所有写命令继续遵循：

- Schema 校验。
- command/operation ID 幂等。
- `BEGIN IMMEDIATE` 事务。
- 不可变事件。
- outbox 同事务提交。
- audit 可重算。

## 8. 遥测数据与活动协议

### 8.1 独立遥测库

新增：

```text
runtime/monitor/monitor.db
```

建议表：

```text
monitor_events
agent_activities
agent_health_snapshots
session_links
session_cursors
artifact_cursors
redaction_audit
```

该库不参与 workflow/task 状态裁决，可以删除后重建。

### 8.2 Agent Activity Envelope

```json
{
  "schema_version": 1,
  "activity_id": "ACT-...",
  "workflow_id": "WF-...",
  "task_id": "TASK-...",
  "run_id": "RUN-...",
  "dispatch_id": "DSP-...",
  "agent_id": "developer-agent",
  "session_id": "session-...",
  "kind": "PROGRESS",
  "status": "RUNNING",
  "current_action": "正在实现快照投影",
  "summary": "已完成数据库查询，正在构建父子关系",
  "checkpoint": {
    "id": "SNAPSHOT_PROJECTOR",
    "title": "实现快照投影",
    "status": "IN_PROGRESS"
  },
  "progress": {
    "completed": 2,
    "total": 5,
    "percent": 40
  },
  "tool": null,
  "visibility": "USER_SAFE",
  "timestamp": "2026-08-05T08:00:00.000Z"
}
```

活动类型：

```text
STARTED
HEARTBEAT
PROGRESS
CHECKPOINT_UPDATED
TOOL_STARTED
TOOL_FINISHED
WAITING_CHILD
WAITING_HUMAN
BLOCKED
OUTPUT_SUMMARY
COMPLETED
FAILED
```

### 8.3 上报时机

Agent 必须在以下时机上报：

1. 完成 preflight 并开始任务。
2. 开始一个重要阶段。
3. 完成一个可验证 checkpoint。
4. 发起预计耗时较长的工具调用。
5. 长工具调用结束。
6. 等待人工、依赖或子 Agent。
7. 遇到阻塞。
8. 完成产物并准备返回。
9. 失败并停止继续执行。

上报内容只包括当前动作、完成事实、下一步、阻塞和产物定位，不要求完整推理过程。

### 8.4 Session Tailer 兜底

显式 activity 是高可信主信号；Session Tailer 是 Agent 未及时上报时的兜底。

Tailer 应：

- 从 OpenClaw 配置或 install manifest 定位 Agent session 目录。
- 按 inode/path、offset 和最后 sequence 增量读取。
- 只处理最近活动的已关联 session。
- 解析非 thinking assistant 文本、tool use 和 tool result。
- 不解析或立即丢弃 thinking。
- 对输出执行凭据、路径、个人信息和长文本脱敏。
- 把无法关联的 session 标记为 `UNTRACKED_SESSION`，不猜测归属。

### 8.5 Monitor Event Envelope

Monitor 对所有来源统一封装：

```json
{
  "event_id": "MEVT-...",
  "sequence": 1024,
  "workflow_id": "WF-...",
  "task_id": "TASK-...",
  "run_id": "RUN-...",
  "session_id": "session-...",
  "topic": "agent.activity",
  "event_type": "progress.updated",
  "producer": "activity-api",
  "source": "EXPLICIT_ACTIVITY",
  "timestamp": "2026-08-05T08:00:00.000Z",
  "payload": {},
  "meta": {
    "redacted": true,
    "inferred": false,
    "confidence": "HIGH"
  }
}
```

建议 topic：

```text
workflow.status
task.status
task.dispatch
agent.activity
agent.output
agent.heartbeat
task.health
task.possibly_stalled
supervision.request
supervision.result
monitor.health
```

## 9. Agent 健康与停滞判定

### 9.1 证据来源

健康投影必须综合：

1. workflow phase/condition/outcome。
2. task 当前状态和 `updated_at`。
3. task event。
4. dispatch 状态。
5. lease deadline。
6. completion receipt。
7. 显式 activity/checkpoint。
8. session JSONL 最近活动。
9. 最近工具开始/结束。
10. artifact、raw-log 和 worktree 文件变化。
11. Gateway/process 探测。

进程存在只能作为低置信度证据，不能单独判定为 RUNNING。

### 9.2 派生健康状态

```text
NOT_STARTED
STARTING
RUNNING
WAITING_CHILD
WAITING_HUMAN
BLOCKED
STALE
POSSIBLY_STALLED
COMPLETED
FAILED
LOST
UNKNOWN
UNTRACKED_SESSION
```

状态说明：

| 状态 | 判定 |
|---|---|
| `NOT_STARTED` | dispatch 已准备但没有发送事实 |
| `STARTING` | 已 SENT/ACKNOWLEDGED，尚未 RUNNING |
| `RUNNING` | task/dispatch 为 RUNNING 且近期有可靠活动 |
| `WAITING_CHILD` | activity 明确等待已登记子任务 |
| `WAITING_HUMAN` | 权威 task/workflow 或 activity 明确等待人工 |
| `BLOCKED` | Agent 或权威状态明确阻塞 |
| `STALE` | 超过 heartbeat 阈值，尚未达到监督阈值 |
| `POSSIBLY_STALLED` | 多项证据持续无变化并超过任务阈值 |
| `COMPLETED` | completion/task event 已落盘 |
| `FAILED` | completion/task event 明确失败 |
| `LOST` | manager 核查后确认 session 丢失 |
| `UNKNOWN` | 数据缺失或冲突 |

### 9.3 置信度

```text
HIGH    权威 task/dispatch/completion 或显式结构化 activity
MEDIUM  task、session、tool 和 artifact 多项证据一致
LOW     只有 mtime、关键词或 process probe
UNKNOWN 证据缺失或相互冲突
```

### 9.4 默认阈值

阈值必须可按 task type 覆盖，初始建议：

```yaml
scan_interval_seconds: 30
heartbeat_stale_seconds: 180
possibly_stalled_seconds: 300
starting_timeout_seconds: 120
nudge_response_timeout_seconds: 300
supervision_cooldown_seconds: 300
manager_wake_retry_seconds: [10, 30, 60, 180]
max_nudges_per_run: 2
max_reconcile_per_run: 2
```

`lease_deadline` 是强制核查边界，不是自动判定 LOST 的边界。

## 10. 监督执行状态机

### 10.1 总体流程

```text
Watchdog 发现疑似停滞
        │
        ▼
保存 health evidence
        │
        ▼
生成幂等 supervision request + wake outbox
        │
        ▼
Wake Adapter 唤醒 manager-agent
        │
        ▼
manager 运行 Control Kernel audit
        │
        ├─ audit 失败 → HOLD/请求失败，不执行外部动作
        │
        ▼
查询原 session、dispatch、artifact 和 activity
        │
        ├─ 仍在运行 → 向原 session 发送 NUDGE
        ├─ 已完成但未回执 → 对账并 ingest completion
        ├─ 明确失败/丢失 → 结束原 dispatch，评估 retry
        └─ 证据冲突 → 升级人工
        │
        ▼
写 supervision receipt/event
```

### 10.2 分级策略

| 级别 | 触发 | 动作 |
|---|---|---|
| L0 | heartbeat 超时 | 只标记 STALE，不执行外部动作 |
| L1 | 达到停滞阈值 | manager 向原 session 催办进度和阻塞原因 |
| L2 | 催办无响应 | manager 查询 session history、artifact、Gateway 并对账 |
| L3 | 确认 FAILED/LOST | 在 `max_attempts` 内创建新 attempt/run |
| L4 | 超预算或证据冲突 | workflow HOLD/WAITING_HUMAN，通知用户 |

### 10.3 NUDGE 语义

NUDGE 消息只要求：

```text
请汇报当前 checkpoint、已经完成的事实、正在执行的动作、阻塞原因和下一步。
不要重新开始任务，不要重复已完成的外部副作用。
```

NUDGE 不改变 task 状态，不延长 retry budget；收到有效 activity 后关闭该请求并重置健康计时。

### 10.4 Retry 规则

- 原 session 未确认 FAILED/LOST 前禁止 retry。
- retry 必须创建新 attempt 或合法新 run。
- 不复用已终结 dispatch 的幂等键。
- 重新验证 context manifest 和 input commit。
- 不覆盖旧 artifact、result、event 和日志。
- 超过 `max_attempts` 必须人工处理。
- 外部副作用不确定时先对账，不能通过重跑“试试看”。

### 10.5 明确禁止自动回滚

Watchdog 不得把 task 或 workflow 恢复到历史快照。

原因：

- 历史阶段可能已经产生 Git、文件、网络或 session 副作用。
- 回滚快照不能回滚外部世界。
- 直接回滚可能绕过 reducer、Gate 和审批。
- 当前状态机已经提供 HOLD、FAILED、LOST、NEEDS_REWORK 和新 attempt 语义。

## 11. Manager 与工作 Agent 规则修改

### 11.1 manager-agent

新增硬性规则：

1. 新会话启动、恢复或被 Watchdog 唤醒时，查询未处理 supervision request。
2. claim 请求前重新读取 workflow/task/dispatch，并运行 audit。
3. NUDGE 必须发送到 request 绑定的原 session。
4. 不因 lease 过期直接写 LOST。
5. 不因 Agent 聊天回复“完成”直接关闭请求，仍需验证 artifact/receipt。
6. retry 必须使用新 attempt/run。
7. 所有动作写 supervision event 和 receipt。
8. 请求处理失败不能静默丢弃，必须保留错误码与下一建议。
9. 完成 workflow 前确认没有未决 supervision request。

### 11.2 工作 Agent

新增规则：

1. preflight 后上报 STARTED。
2. 每个重要 checkpoint 上报 PROGRESS/CHECKPOINT_UPDATED。
3. 长工具调用前后上报 TOOL_STARTED/TOOL_FINISHED。
4. 等待必须明确区分 WAITING_CHILD、WAITING_HUMAN 和 BLOCKED。
5. NUDGE 只汇报现状，不重新执行任务。
6. completion 前确保全部必需产物已经落盘并自检。
7. 不上报完整思考过程。

## 12. Monitor 服务设计

### 12.1 技术选型

- Node.js ESM，与当前项目一致。
- Node 内置 SQLite，避免新增数据库依赖。
- React + Vite 构建 Dashboard。
- SSE 作为第一期实时推送。
- `fs.watch` 快速发现 session/artifact 变化，定时 reconciliation 兜底。
- Ajv 校验所有新增 JSON/JSONL 协议。

第一期不引入 Redis、Postgres、NATS 或独立 Python 服务。

### 12.2 API

```text
GET  /api/health
GET  /api/workflows
GET  /api/workflows/:workflowId/snapshot
GET  /api/workflows/:workflowId/events?after=<sequence>&limit=<n>
GET  /api/workflows/:workflowId/stream?after=<sequence>
GET  /api/tasks/:taskId
GET  /api/tasks/:taskId/activity
GET  /api/tasks/:taskId/health
GET  /api/agents/:agentId/activity
GET  /api/supervision?status=<status>
POST /api/supervision/request
```

POST 只调用受限 Control Kernel 命令生成监督请求，不直接写数据库。

### 12.3 SSE

```text
event: snapshot
event: workflow-status
event: task-status
event: activity
event: health
event: supervision
event: monitor-health
```

客户端断线后携带最后 sequence，服务先补发缺失事件，再恢复实时订阅。

### 12.4 一致性策略

- 初次连接发送完整 snapshot。
- 后续只发送增量事件。
- 每 2 秒执行轻量 reconcile，修复丢失的文件通知。
- 每 30 秒重新计算健康状态。
- Monitor 重启后从 control.db、session cursor 和 artifact 重建。
- 发现控制投影与数据库冲突时以数据库为准并显示 Monitor DEGRADED。

## 13. Dashboard 页面设计

### 13.1 顶部总览

显示：

- 活动 workflow 数。
- RUNNING Agent 数。
- WAITING/BLOCKED 数。
- STALE/POSSIBLY_STALLED 数。
- 待处理 supervision request 数。
- 最近五分钟活动数。
- Gateway、Control Kernel、Monitor 健康状态。
- SSE 延迟和最后同步时间。

### 13.2 Workflow 阶段看板

按当前 SDLC 阶段展示：

```text
INTAKE
REQUIREMENTS
REQUIREMENT_GATE
ARCHITECTURE
ARCHITECTURE_GATE
DEVELOPMENT
CODE_REVIEW
DEVELOPER_REWORK
TESTING
TEST_CODE_REVIEW
FAILURE_TRIAGE
RELEASE_VERIFICATION
FINAL_REPORT
```

Task 卡片显示：

- task type、title、assigned agent。
- status、run、attempt/max attempts。
- dispatch/session 状态。
- 当前 checkpoint。
- 运行时长和最后活动。
- lease 剩余时间。
- 健康状态、置信度和证据数量。
- 阻塞或待人工原因。

### 13.3 Agent 协作树

```text
manager-agent
├── requirement-agent   COMPLETED
├── architect-agent     RUNNING
├── developer-agent     POSSIBLY_STALLED
├── review-agent        NOT_STARTED
└── test-agent          WAITING_CHILD
```

节点显示：

- Agent ID/角色。
- task/run/session。
- 当前动作。
- 最近安全摘要。
- checkpoint 与百分比。
- 最近 heartbeat。
- 健康状态和置信度。
- 父子 session 关系。

### 13.4 任务详情抽屉

包括：

1. workflow/task/run/dispatch/session 标识。
2. task 描述、依赖和验收标准。
3. 当前状态与状态事件。
4. activity/checkpoint 时间线。
5. 工具调用名称、阶段和短输出。
6. artifact、result 和 evidence 定位。
7. lease、retry 和 attempt。
8. 健康判定证据。
9. supervision 请求与执行历史。
10. 可用人工命令。

### 13.5 人工操作

第一批：

```text
催办进度
发送补充说明
请求核查 session
请求暂停
请求恢复
升级人工处理
```

后续再开放取消和 retry。所有按钮先显示目标 workflow/task/run/session 和影响预览，再创建请求。

## 14. 目录和文件规划

### 14.1 新增

```text
monitor/
├── server.mjs
├── config.mjs
├── control-read-model.mjs
├── snapshot-projector.mjs
├── event-source.mjs
├── event-hub.mjs
├── activity-api.mjs
├── activity-classifier.mjs
├── health-classifier.mjs
├── watchdog.mjs
├── wake-adapter.mjs
├── session-tailer.mjs
├── session-parser.mjs
├── artifact-watcher.mjs
├── redactor.mjs
├── telemetry-repository.mjs
└── ui/
    ├── index.html
    ├── src/
    │   ├── App.tsx
    │   ├── api.ts
    │   ├── store.ts
    │   └── components/
    │       ├── Overview.tsx
    │       ├── WorkflowBoard.tsx
    │       ├── AgentTree.tsx
    │       ├── TaskDrawer.tsx
    │       ├── ActivityFeed.tsx
    │       ├── HealthEvidence.tsx
    │       └── SupervisionPanel.tsx
    └── package.json

contracts/agent-activity.schema.json
contracts/agent-checkpoint.schema.json
contracts/monitor-event.schema.json
contracts/supervision-request.schema.json
contracts/supervision-receipt.schema.json
contracts/supervision-event.schema.json
contracts/manager-wake-record.schema.json

config/monitoring.example.yaml

scripts/monitor-core/emit-activity.mjs
scripts/monitor-core/emit-checkpoint.mjs

tests/monitor-read-model.test.mjs
tests/monitor-snapshot.test.mjs
tests/monitor-activity.test.mjs
tests/monitor-redactor.test.mjs
tests/monitor-session-tailer.test.mjs
tests/monitor-health.test.mjs
tests/monitor-watchdog.test.mjs
tests/monitor-supervision.test.mjs
tests/monitor-http.test.mjs
tests/monitor-sse.test.mjs
tests/manager-wake-outbox.test.mjs
tests/fixtures/monitor/
```

### 14.2 修改

```text
package.json
scripts/control-kernel.mjs
scripts/control-core/repository.mjs
scripts/control-core/task-repository.mjs
scripts/control-core/audit.mjs
scripts/control-core/projections.mjs

agents/common/COMMON_RULES.md
agents/common/CONTEXT_PROTOCOL.md
agents/manager-agent/workspace/AGENTS.md
agents/manager-agent/workspace/TOOLS.md
agents/*/workspace/AGENTS.md
agents/*/workspace/TOOLS.md

docs/architecture.md
docs/control-kernel-v2.md
docs/manager-orchestration.md
docs/state-and-recovery.md
docs/troubleshooting.md
README.md
CHANGELOG.md
docs/current-progress-assessment.md
```

## 15. 分阶段实施计划

### Phase 0：ADR、基线和契约冻结（1～2 人日）

目标：确定边界，避免实现过程中再次形成第二控制面。

工作：

1. 编写 ADR：允许常驻 Monitor、Watchdog 和只唤醒 manager 的 Wake Adapter。
2. 确认 Monitor 对 `control.db` 的只读连接方式。
3. 探测真实 OpenClaw session 目录和 JSONL 格式。
4. 确认 `sessions_send`、manager 唤醒和 session 查询接口。
5. 统计现有 workflow/task/run/dispatch/session 规模。
6. 冻结 activity、monitor event 和 supervision 契约。
7. 定义敏感字段与脱敏规则。

验收：

- 不修改 OpenClaw 配置。
- 不改变现有 workflow/task 状态。
- 形成 baseline 文档和 ADR。

### Phase 1：Control Kernel 只读模型与监督表（3～4 人日）

目标：提供适合 Dashboard 的一致性读取，并建立监督事实存储。

工作：

1. 新增 read-model 查询 workflow/task/run/dispatch/outbox/event。
2. 新增 `snapshot` 命令或内部只读 API。
3. 新增 supervision request/event/wake outbox 表和迁移。
4. 新增 supervision 命令及幂等处理。
5. 扩展 audit 校验监督事件链、请求状态和 outbox。
6. 增加并发、重复 command 和响应丢失测试。

验收：

- 原 Control Kernel 测试全部通过。
- 重复 request 不产生重复记录。
- audit 可以发现监督事件篡改和状态不一致。

### Phase 2：只读 Monitor MVP（2～3 人日）

目标：在没有 activity 的情况下先看到现有控制状态。

工作：

1. 实现 Monitor server 和配置加载。
2. 只读查询 `control.db`。
3. 构建 workflow/task/run/dispatch/session 基础节点。
4. 提供 health、workflow、snapshot、events API。
5. 实现 SSE sequence 和断线回放。
6. 对 v1 workflow 只做降级显示。

验收：

- 不写 `control.db`。
- 没有 activity 时仍能展示完整控制状态。
- Monitor 停止不影响现有测试和工作流。

### Phase 3：Activity、Session Tailer 与脱敏（3～4 人日）

目标：实时看到 Agent 正在做什么，同时不泄露推理和凭据。

工作：

1. 实现 `emit-activity`、`emit-checkpoint`。
2. 创建 `monitor.db`。
3. 实现 session tailer、parser、cursor。
4. 实现 artifact watcher。
5. 实现 thinking 删除、凭据脱敏和文本截断。
6. 更新 Agent 规则和 context package。
7. 把多来源事件统一为 Monitor Event Envelope。

验收：

- activity 到 API P95 小于 1 秒。
- API 到浏览器 P95 小于 2 秒。
- thinking、API Key、cookie、私钥和环境变量不出现在响应中。
- JSONL 末尾半行不会使服务崩溃。

### Phase 4：Dashboard（4～5 人日）

目标：提供可用于日常管理的图形化界面。

工作：

1. 顶部健康总览。
2. Workflow 阶段看板。
3. Agent 协作树。
4. Task 详情抽屉。
5. Activity、tool、artifact 和 supervision 时间线。
6. 状态、Agent、task、事件类型筛选。
7. SSE 断线重连和 sequence 补发。
8. 空状态、DEGRADED 和旧 workflow 降级展示。

验收：

- 用户能从 workflow 下钻到 task/run/session。
- 每个异常状态都能展示判定证据和置信度。
- 浏览器刷新或断线后不丢活动事件。

### Phase 5：Watchdog 影子模式（2～3 人日）

目标：先验证停滞判定，不执行催办。

工作：

1. 实现 health classifier 和定期扫描。
2. 按 task type 应用不同阈值。
3. 记录“如果启用将产生什么请求”。
4. 用真实长任务观察误报和漏报。
5. 校准 tool running、WAITING_HUMAN 和 Gateway 离线场景。

验收：

- 正常长工具调用不被误判为需 retry。
- BLOCKED/WAITING 状态不触发普通催办。
- 同一窗口只产生一个影子动作。

### Phase 6：监督请求与 manager 唤醒（4～5 人日）

目标：形成真正的自动监督闭环。

工作：

1. Watchdog 创建幂等 supervision request 和 wake outbox。
2. Wake Adapter 只唤醒 manager-agent。
3. manager claim、audit、session 核查和 NUDGE。
4. 写 supervision receipt/event。
5. 实现冷却、重试退避和最大次数。
6. Dashboard 开放人工 NUDGE、SEND_MESSAGE 和 RECONCILE。
7. 验证 manager/Monitor/Gateway 重启恢复。

验收：

- 原 session 未确认终结前不会重复 spawn。
- 失败的 manager 唤醒不会丢失请求。
- manager 重启后可以继续处理未完成请求。
- 每次催办都有完整 request、event 和 receipt。

### Phase 7：受控 retry、暂停和人工升级（3～4 人日）

目标：处理真正失联或失败的任务。

工作：

1. 实现 RETRY_REVIEW，而非 Watchdog 直接 retry。
2. manager 确认 FAILED/LOST 后创建新 attempt/run。
3. 实现 PAUSE/RESUME/CANCEL 请求的审批和状态机映射。
4. 超过预算时进入 HOLD/WAITING_HUMAN。
5. 增加影响预览和人工确认。

验收：

- retry 生成新 attempt/run/dispatch。
- 历史 artifact、event 和 receipt 不被覆盖。
- 高风险动作经过现有审批和 Gate 规则。

### Phase 8：可靠性、性能和发布（3～4 人日）

工作：

1. 运行完整测试和故障注入。
2. 完成 Windows/Linux 启动脚本。
3. 日志轮转和 telemetry retention。
4. 本地鉴权、CSRF 和安全 header。
5. 性能基线与容量测试。
6. 更新架构、恢复、排障、README、CHANGELOG 和完成度评估。
7. 先 shadow rollout，再开启自动 NUDGE，最后开启受控 retry。

总估算：约 22～30 人日。MVP 看板为 Phase 0～4；真正的自动监督必须完成 Phase 5～6。

## 16. 测试计划

### 16.1 契约测试

- 所有 activity、monitor event、supervision request/receipt/event 通过 Ajv。
- workflow/task/run/dispatch/agent 身份必须一致。
- 非法 request type、状态和路径被拒绝。
- activity 不能冒充其他 task/run/agent。

### 16.2 Control Kernel 测试

- supervision request 幂等重放。
- 同 request ID 不同内容失败关闭。
- request/event/outbox 同事务提交。
- 并发 claim 只能有一个成功。
- audit 检测哈希、sequence、状态和 outbox 不一致。
- 响应丢失后相同 command 重放返回原结果。

### 16.3 Monitor 投影测试

- 无活动 workflow。
- 多 workflow。
- task 各种状态。
- dispatch PREPARED/SENT/ACKNOWLEDGED/RUNNING/终态。
- projection 缺失或漂移。
- v1 workflow 降级。
- control.db 暂时锁定。
- Monitor 重启重建。

### 16.4 Activity 与 Tailer 测试

- 显式 activity 正常写入。
- JSONL 末尾半行。
- 文件截断和轮转。
- 同一事件重复读取。
- thinking 不进入 telemetry。
- tool use/result 正确配对。
- 超长输出截断。
- token、cookie、密码和私钥脱敏。
- 未跟踪 session 不自动归属 workflow。

### 16.5 Watchdog 测试

- 正常 RUNNING 不触发。
- TOOL_STARTED 且工具仍活跃不触发。
- WAITING_HUMAN 不触发普通 NUDGE。
- Gateway 离线标记基础设施异常。
- lease 过期只生成 RECONCILE。
- 同一冷却窗口不重复请求。
- 连续无响应按 L1→L2→L3 升级。
- 达到 max attempts 后进入人工处理。

### 16.6 端到端测试

```text
创建 workflow
→ task-register/task-validate
→ dispatch-prepare
→ fake sessions_spawn
→ SENT/ACKNOWLEDGED/RUNNING
→ activity 实时显示
→ 停止 activity
→ Watchdog 创建请求
→ Wake Adapter 唤醒 fake manager
→ manager NUDGE 原 session
→ Agent 恢复 activity
→ 请求关闭
→ result-ingest
→ Dashboard 显示完成
```

### 16.7 故障注入

- Monitor 在写 telemetry 时退出。
- Watchdog 在创建请求后退出。
- Wake Adapter 调用成功但响应丢失。
- manager 被唤醒但 claim 前退出。
- manager claim 后执行前退出。
- Gateway 离线后恢复。
- session 已完成但 completion 未写。
- session 丢失但 lease 尚未到期。
- SQLite busy/locked。
- SSE 连接大量断开重连。

### 16.8 安全测试

- thinking 不出现在 DB、API、SSE 和浏览器。
- XSS 文本经过安全渲染。
- 路径穿越被拒绝。
- Monitor 不能写 workflow/task 状态。
- 监督命令不能指向不存在或不匹配的 Agent。
- 本地 API 默认拒绝非允许 origin。
- 日志不记录凭据和完整 session 内容。

## 17. 性能与容量指标

第一期目标规模：

```text
活动 workflow       100
累计 task            10,000
并发 Agent/session   50
单 workflow 事件     100,000
SSE 客户端           20
```

验收指标：

| 指标 | 目标 |
|---|---|
| Snapshot API P95 | ≤ 500 ms |
| 初次页面可用 | ≤ 2 s |
| Activity 到 Monitor | ≤ 1 s |
| Monitor 到浏览器 | ≤ 2 s |
| SSE 重连恢复 | ≤ 3 s |
| Watchdog 扫描 | ≤ 1 s/100 个活动 task |
| Monitor 重启重建 | ≤ 30 s |
| 稳态 CPU | < 10% 单核 |
| 稳态内存 | < 300 MB |

优化策略：

- 只读增量游标，不重复全表扫描。
- session 文件只尾读。
- snapshot 使用短 TTL 缓存。
- SSE 只推增量。
- activity 批量事务写入。
- 完结 workflow 降低扫描频率。
- telemetry 按保留策略归档。

## 18. 上线、回滚与兼容

### 18.1 上线顺序

1. 只读 Monitor。
2. Activity/Session Tailer。
3. Dashboard。
4. Watchdog 影子模式。
5. 自动 NUDGE。
6. RECONCILE。
7. 受控 retry 和高风险命令。

每一阶段通过验收后才开启下一阶段功能开关。

### 18.2 功能开关

```yaml
monitor_enabled: true
session_tailer_enabled: true
watchdog_enabled: true
watchdog_shadow_mode: true
auto_nudge_enabled: false
manager_wake_enabled: false
controlled_retry_enabled: false
```

### 18.3 回滚

- 关闭 Monitor 不影响 workflow。
- 关闭 Watchdog 后不再创建自动请求。
- 关闭 Wake Adapter 后请求留在 outbox 等待恢复。
- `monitor.db` 可删除重建。
- supervision 表属于追加控制事实，不通过删除记录回滚。
- 已发送的外部消息不能假装撤销，只能记录后续补偿事件。

### 18.4 兼容

- v2 workflow 使用完整看板和监督。
- v1 workflow 只读展示基础状态，不执行自动监督。
- 没有显式 activity 的 Agent 通过 Session Tailer 降级显示。
- Session Tailer 不可用时继续显示权威 task/dispatch 状态。

## 19. 最终验收标准

项目只有同时满足以下条件，才能宣布看板和监督机制完成：

### 看板

- 能看到所有活动 workflow。
- 能按 workflow→task→run→dispatch→session 下钻。
- 能看到 Agent 当前动作、checkpoint、工具摘要和最近活动。
- 能看到 WAITING、BLOCKED、FAILED、LOST、STALE 和 POSSIBLY_STALLED。
- 每个异常都有证据和置信度。
- SSE 断线后可以补发事件。
- Monitor 重启后可以确定性重建。

### 监督

- 同一停滞窗口最多一个监督请求。
- Watchdog 不直接联系工作 Agent。
- manager 处理前必须 audit 和核查原 session。
- 原 session 未确认终结前不重复 spawn。
- retry 使用新 attempt/run。
- 超过预算后进入人工处理。
- 每个监督动作都有 request、event、outbox 和 receipt。

### 控制与安全

- `control.db` 始终是唯一控制状态权威。
- Monitor 不拥有 task/workflow 状态写权限。
- Control Kernel audit 全部通过。
- Runtime Guard、Gate、审批和 Git 规则不被绕过。
- thinking、凭据、完整 prompt 和未脱敏日志不进入浏览器。
- Monitor、Watchdog 或 Wake Adapter 故障不破坏主 workflow。

## 20. 推荐实施决策

建议批准以下架构决策：

1. **采用常驻 Node.js Monitor 服务。** 当前“没有常驻编排器”的原则调整为“没有第二个
   状态权威和没有直接调度工作 Agent 的服务”。
2. **允许 Watchdog 自动创建监督请求。** Watchdog 只做检测和 durable request，不执行
   工作流动作。
3. **允许 Wake Adapter 唤醒 manager-agent。** 它不能直接联系工作 Agent。
4. **监督请求进入 `control.db`。** 它是控制事实，不能只存在于遥测库。
5. **Activity 进入独立 `monitor.db`。** 它是可重建观测数据，不污染权威 task 快照。
6. **第一期使用 SSE。** 双向控制仍走 HTTP request → Control Kernel → manager 闭环。
7. **禁止自动状态回滚。** 使用核查、新 attempt、HOLD 和人工审批替代。
8. **先影子模式，再自动催办。** 先验证误报率，再开启外部动作。

## 21. 里程碑摘要

| 里程碑 | 内容 | 结果 |
|---|---|---|
| M0 | ADR、基线、契约 | 明确边界与真实 runtime 格式 |
| M1 | Control read-model + supervision tables | 具备可靠读取和监督事实存储 |
| M2 | Monitor API + SSE | 能查看现有 workflow/task/dispatch |
| M3 | Activity + Session Tailer | 能看到 Agent 安全实时进展 |
| M4 | Dashboard | 能图形化查看、筛选和下钻 |
| M5 | Watchdog shadow | 能证据化识别疑似停滞 |
| M6 | Manager supervision loop | 能自动催办和对账 |
| M7 | Controlled retry/escalation | 能安全处理真正失联和失败 |
| M8 | Hardening/rollout | 可长期稳定运行 |

本计划完成后，当前项目将获得 edict-main 中最有价值的“任务看板、活动时间线、心跳、停滞
检测、催办和升级”能力，同时保留 Control Kernel v2 在单一事实源、事务、不可变事件、
幂等 dispatch、Gate、审批和恢复方面的优势。
