# 多 Agent 实时可观测与交互平台改造计划

> 日期：2026-08-04  
> 状态：待评审  
> 目标：在当前 OpenClaw 文件化多 Agent 协作工具上，增加轻量级、可回放、可交互的实时监控平台。  
> 参考项目：`D:\MicroConnect\project\edict-main`

## 1. 结论摘要

建议采用“文件化事实源 + 只读监控投影 + 实时推送 + manager 命令闭环”的路线。

第一期不新增独立调度器，也不改变当前 `manager-agent` 的唯一编排者职责，而是新增一个本地 Observability Monitor：

```text
OpenClaw Agent / manager-agent
       │
       ├─ workflow.json / task.json / events.jsonl
       ├─ dispatch receipts / completion receipts
       ├─ Agent run 的 live-status.json / activity.jsonl
       └─ OpenClaw session JSONL（只读取、尾读、脱敏）
                         │
                         ▼
               Monitor Event Adapter
                         │
                         ├─ 历史事件回放
                         ├─ 当前状态投影
                         ├─ 心跳和停滞判定
                         └─ 父子 Agent 关系图
                         │
                         ▼
             本地 HTTP API + SSE 实时推送
                         │
                         ▼
               图形化 Dashboard / 时间线
                         │
                         ▼
       用户命令请求 → manager-agent 校验并执行
```

实时输出的默认范围是安全摘要，不展示完整思考过程：

- 展示 Agent 的阶段性文本回复、当前动作、Todo/checkpoint 变化。
- 展示工具调用名称、开始/完成状态、耗时和脱敏后的输出摘要。
- 展示心跳、状态转换、子 Agent 创建和完成信息。
- 默认丢弃 `thinking` / chain-of-thought 字段，不将其转发到前端。
- 原始 session 文件、完整 prompt、认证信息和未脱敏命令输出不直接暴露给浏览器。

## 2. 参考 edict-main 得出的改进点

### 2.1 值得直接借鉴的部分

| edict-main 的做法 | 对当前项目的改进方式 |
|---|---|
| `event_bus.py` 使用 topic、trace_id、producer、payload、meta 统一事件结构 | 增加统一的 Monitor Event Envelope，所有状态、活动、输出和心跳使用同一关联字段 |
| Redis Streams + Pub/Sub 支持可靠消费和实时广播 | MVP 先使用 `events.jsonl`/`activity.jsonl` 回放 + 进程内 SSE；保留 EventBusAdapter 接口，后续可接 Redis/NATS |
| Outbox Relay 避免业务数据与事件投递双写不一致 | 当前不改写控制事件；Agent 活动先落本地文件，再由 Monitor 投影，避免只推送未落盘 |
| WebSocket 全局频道和单任务频道 | MVP 提供全局 workflow SSE 和单 task SSE；第二期加入 WebSocket 双向命令通道 |
| `get_agent_activity` 读取 session JSONL，提取 assistant、tool_use、tool_result | 增加 OpenClaw Session Tailer，读取实时安全输出，作为显式 Agent 上报之外的兜底通道 |
| Session 内容按 Agent、task_id、关键词过滤 | 优先使用 workflow/task/run/session 标识做精确关联，关键词只作为 `inferred=true` 的兼容回退 |
| Agent 状态综合 session 更新时间、进程、workspace 和 Gateway 状态 | 当前使用 task、dispatch lease、activity、session mtime、output mtime 多证据判定，不以进程存在单独认定正在工作 |
| MonitorPanel、TaskModal、SessionsPanel 分离展示 | 当前 Dashboard 分为总览、Agent 树、任务详情抽屉、实时输出面板、事件时间线和会话详情 |
| 看板支持过滤、任务详情、叫停、取消、恢复、重试和升级 | 先做查看/筛选；第二期通过 command request 交给 manager 执行，保留审批和审计闭环 |
| `flow_log`、`progress_log`、`todos`、scheduler state | 当前增加 progress/checkpoint/last_progress_at/health_evidence 的监控投影，不直接污染权威 task 快照 |
| 性能基线和升级计划单独成文 | 增加 Monitor 专项性能基线、浏览器首屏、SSE 延迟、快照耗时和文件扫描规模验收 |

### 2.2 不直接照搬的部分

edict-main 的生产方案使用 FastAPI、Redis、Postgres 和 React，而当前项目明确没有常驻 Python 控制平面，并且控制文件由 `manager-agent` 负责。因此第一期不直接引入：

- Redis/Postgres 作为运行前置依赖。
- 另一个可以自行调度 Agent 的后端服务。
- 直接让网页修改 `workflow.json` 或 `events.jsonl`。
- 将完整思考过程写入数据库或推送给所有浏览器。

后续规模变大时，可以替换 Monitor 的事件适配层，而不改变前端事件协议和现有控制层事实源。

## 3. 当前项目的约束与必须保留的边界

现有架构以以下文件作为主要事实源：

- [docs/architecture.md](D:/MicroConnect/project/openclaw-multi-agent/docs/architecture.md)
- [docs/state-and-recovery.md](D:/MicroConnect/project/openclaw-multi-agent/docs/state-and-recovery.md)
- [docs/manager-orchestration.md](D:/MicroConnect/project/openclaw-multi-agent/docs/manager-orchestration.md)
- [contracts/workflow-event.schema.json](D:/MicroConnect/project/openclaw-multi-agent/contracts/workflow-event.schema.json)
- [contracts/task.schema.json](D:/MicroConnect/project/openclaw-multi-agent/contracts/task.schema.json)

改造必须遵守：

1. `manager-agent` 仍是 workflow、task、gate、approval、dispatch 控制文件的唯一逻辑写入者。
2. `events.jsonl` 仍然 append-only、哈希链完整，Monitor 只能读取和回放。
3. Agent 只写当前 run 允许的 `output/`、`raw-logs/` 和 worktree。
4. Monitor 不调用 `sessions_spawn`，不自行重试、不自行推进状态、不绕过 Gate。
5. 用户的暂停、取消、重试、催办等动作先生成命令请求，由 manager 校验后执行。
6. 子 Agent 必须具有可追踪的父 task、父 run 或父 session 关系；未登记的子会话必须标记为 `UNTRACKED_CHILD`。
7. 监控不可用时，主 workflow 仍能依靠原有文件恢复运行。

## 4. 目标能力范围

### 4.1 第一阶段必须具备

- 实时看到多个 workflow 和当前 workflow 的 Agent 层级。
- 看到 manager、worker 和新增 subagent。
- 看到每个 Agent 当前任务、当前动作、最近输出摘要和最近活动时间。
- 看到安全的工具调用和工具输出摘要。
- 看到 Todo/checkpoint 变化。
- 看到等待人工、阻塞、失败、完成、未启动、疑似停滞等状态。
- 通过页面点击查看任务详情、活动时间线和子 Agent 输出。
- 支持断线重连后按事件序号回放，不依赖浏览器一直在线。
- 旧 workflow 没有新 activity 文件时仍能显示基础状态。

### 4.2 第二阶段增加

- 催 Agent 汇报进度。
- 向指定 Agent 发送补充说明。
- 请求暂停、恢复、取消、重试和升级。
- 子 Agent 输出摘要实时反馈给父 Agent 或 manager。
- 时间线按 task、agent、session、topic 过滤。

### 4.3 后续可选能力

- Redis Streams/NATS EventBus 适配。
- WebSocket 双向订阅。
- OpenTelemetry trace/span。
- token、耗时、成本统计。
- 历史运行对比、回放和 Agent 性能趋势。

### 4.4 明确不纳入第一期

- 展示完整 chain-of-thought。
- 自动给 Agent 贴“偷懒”标签并自动处理。
- Monitor 直接控制 Agent 生命周期。
- 引入数据库迁移、Redis 安装或后台服务编排。
- 允许任意工作 Agent 无记录地调用任意子 Agent。

## 5. 数据与事件模型

### 5.1 现有权威数据继续保留

Monitor 读取：

```text
runtime/control/active-workflows.json
runtime/control/workflows/<workflow-id>/workflow.json
runtime/control/workflows/<workflow-id>/tasks/*.json
runtime/control/workflows/<workflow-id>/events.jsonl
runtime/control/workflows/<workflow-id>/dispatch/*
runtime/artifacts/<workflow-id>/<task-id>/<run-id>/output/*
runtime/artifacts/<workflow-id>/<task-id>/<run-id>/raw-logs/*
```

状态事件继续由现有 Runtime Guard 和 manager 产生。Monitor 不把监控派生状态写回 `workflow.json`，而是重新计算或写入自己的缓存。

### 5.2 Agent 活动文件

新增每个 run 的目录：

```text
artifacts/<workflow-id>/<task-id>/<run-id>/output/monitor/
├── live-status.json
├── activity.jsonl
└── checkpoints.json
```

新增：

```text
contracts/agent-activity.schema.json
contracts/agent-live-status.schema.json
contracts/agent-checkpoint.schema.json
templates/agent-activity.json
templates/agent-live-status.json
```

`live-status.json` 是当前快照；`activity.jsonl` 是本 run 的活动历史；`checkpoints.json` 是可选的结构化 Todo/checkpoint 快照。它们都是 Agent 自己 run artifact 的一部分，不取代控制层状态。

建议字段：

```json
{
  "schema_version": 1,
  "activity_id": "ACT-...",
  "workflow_id": "WF-...",
  "task_id": "TASK-...",
  "run_id": "RUN-...",
  "agent_id": "developer-agent",
  "session_id": "session-...",
  "parent_agent_id": "manager-agent",
  "parent_task_id": null,
  "parent_run_id": null,
  "parent_session_id": null,
  "kind": "PROGRESS",
  "status": "RUNNING",
  "current_action": "正在实现 Agent 树投影",
  "summary": "已完成事件读取，正在实现父子关系归并",
  "progress": {
    "completed": 2,
    "total": 5,
    "percent": 40
  },
  "tool": {
    "name": "shell",
    "phase": "FINISHED",
    "duration_ms": 1200,
    "output_preview": "已读取 12 个任务文件"
  },
  "visibility": "USER_SAFE",
  "redaction": {
    "thinking_removed": true,
    "secrets_removed": true,
    "max_preview_chars": 500
  },
  "timestamp": "2026-08-04T08:00:00.000Z",
  "last_heartbeat_at": "2026-08-04T08:00:00.000Z"
}
```

活动类型建议：

```text
STARTED
HEARTBEAT
PROGRESS
CHECKPOINT_UPDATED
TOOL_STARTED
TOOL_FINISHED
OUTPUT_CHUNK
WAITING_CHILD
WAITING_HUMAN
BLOCKED
SPAWNED_CHILD
CHILD_COMPLETED
COMPLETED
FAILED
```

`OUTPUT_CHUNK` 只允许安全摘要或经过明确脱敏的文本片段，不能用于转发完整思考过程。

### 5.3 Session JSONL 兜底读取

借鉴 edict-main/dashboard/server.py 中对 Agent session JSONL 的解析方式，新增：

```text
scripts/monitor-core/session-tailer.mjs
scripts/monitor-core/session-parser.mjs
scripts/monitor-core/redactor.mjs
```

读取优先级：

1. 从当前 OpenClaw Agent 配置或 install manifest 得到 Agent 的 `agentDir`。
2. 发现其 session JSONL 目录。
3. 只尾读最近变化的文件，不全量扫描所有历史会话。
4. 解析 assistant 文本、tool_use、tool_result、session 更新时间。
5. 丢弃 `thinking` 内容。
6. 对命令输出、路径、环境变量、token、密钥和疑似凭据执行脱敏与截断。
7. 产生统一的 `agent.activity` Monitor Event。

解析结果的 `source` 标记为：

```text
EXPLICIT_ACTIVITY
SESSION_TAIL
TASK_EVENT
DISPATCH_RECEIPT
INFERRED_SESSION
```

Session Tailer 只是可观测性读取器，不修改 session 文件，不把原始 session 内容写入控制层。

### 5.4 父子 Agent 关系

现有 `task.schema.json` 已有 `parent_task_id`，应继续使用，并补充 dispatch intent 的父子字段：

```text
parent_session_id
parent_agent_id
parent_task_id
parent_run_id
spawn_depth
spawn_reason
child_session_id
child_task_id
child_run_id
```

每次 `sessions_spawn` 前必须先生成 child task/run 或等价的 tracked session 记录，再创建 dispatch intent。Monitor 的节点 ID 使用：

```text
agent_id + task_id + run_id + session_id
```

关系推断优先级：

1. `parent_session_id`
2. `parent_run_id`
3. `parent_task_id`
4. dispatch intent 的父子字段
5. session 内容中的明确 ID
6. 关键词匹配，仅作为 `inferred=true`

当前工作 Agent 默认禁止继续 spawn。后续开放子 Agent 时，必须同时开放“登记、追踪、状态上报、完成回执”协议，不能只修改 `allowAgents`。

## 6. 事件封装与实时传输

### 6.1 Monitor Event Envelope

借鉴 edict-main 的 topic/trace/producer/meta 结构，Monitor 内部统一使用：

```json
{
  "event_id": "MEVT-...",
  "sequence": 1024,
  "workflow_id": "WF-...",
  "task_id": "TASK-...",
  "run_id": "RUN-...",
  "session_id": "session-...",
  "parent_session_id": "session-parent",
  "topic": "agent.activity",
  "event_type": "progress.updated",
  "producer": "session-tailer",
  "source": "SESSION_TAIL",
  "timestamp": "2026-08-04T08:00:00.000Z",
  "payload": {},
  "meta": {
    "redacted": true,
    "inferred": false
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
agent.child.spawned
agent.child.completed
task.stalled
monitor.health
```

### 6.2 第一阶段传输方式：文件回放 + SSE

第一期采用：

- `events.jsonl` 和 `activity.jsonl` 作为可回放历史。
- `fs.watch` 触发快速更新。
- 1～2 秒轮询作为丢通知时的兜底。
- Monitor 进程内 EventHub 扇出给 SSE 客户端。
- 客户端断线后用 `after=sequence` 获取缺失事件，再重新订阅。

建议 API：

```text
GET  /api/health
GET  /api/workflows
GET  /api/workflows/:workflowId/snapshot
GET  /api/workflows/:workflowId/events?after=<sequence>&limit=500
GET  /api/workflows/:workflowId/stream
GET  /api/workflows/:workflowId/tasks/:taskId/activity
GET  /api/workflows/:workflowId/agents/:agentId/activity
```

建议 SSE 事件：

```text
event: snapshot
data: {...}

event: activity
data: {...}

event: output
data: {...}

event: workflow-event
data: {...}

event: monitor-health
data: {...}
```

### 6.3 第二阶段传输方式：WebSocket 双向通道

当需要暂停、催办、重试和发送消息时，再增加 WebSocket：

```text
GET /ws
GET /ws/workflow/:workflowId
GET /ws/task/:taskId
GET /ws/agent/:agentId
```

客户端可以发送：

```json
{
  "type": "subscribe",
  "workflow_ids": ["WF-..."],
  "task_ids": ["TASK-..."],
  "agent_ids": ["developer-agent"]
}
```

但控制消息不直接改变状态，而是转换成 Monitor Command Request，交给 manager 处理。

### 6.4 后续 EventBus 适配

保留以下接口：

```text
EventSource.read_history(cursor)
EventSource.watch()
EventSource.get_snapshot(workflow_id)
EventSource.get_activity(task_id, run_id)
EventHub.publish(event)
EventHub.subscribe(filter)
```

未来接 Redis Streams/NATS 时，只替换 `EventSource` 和 `EventHub`，前端 API 和事件格式不变。当前不把 Redis/Postgres 作为 MVP 安装条件。

## 7. Monitor 服务与目录规划

新增：

```text
monitor/
├── server.mjs
├── config.mjs
├── snapshot-projector.mjs
├── event-source.mjs
├── event-hub.mjs
├── file-watcher.mjs
├── activity-classifier.mjs
├── session-tailer.mjs
├── session-parser.mjs
├── redactor.mjs
└── ui/
    ├── index.html
    ├── app.js
    ├── styles.css
    └── components/
        ├── agent-tree.js
        ├── activity-feed.js
        ├── task-drawer.js
        └── timeline.js
```

新增命令：

```json
{
  "scripts": {
    "monitor": "node monitor/server.mjs",
    "monitor:test": "node --test tests/monitor-*.test.mjs"
  }
}
```

建议启动方式：

```powershell
npm run monitor -- --runtime-root "D:\MicroConnect\project\openclaw-multi-agent\runtime" --host 127.0.0.1 --port 8787
```

默认只监听本机。生产化时再加入 token、反向代理和用户认证。

## 8. 页面设计

页面结构借鉴 edict-main 的 MonitorPanel、TaskModal、SessionsPanel，而不是只做一张静态关系图。

### 8.1 顶部总览

展示：

```text
活动 workflow
运行中 Agent
等待中 Agent
阻塞 Agent
疑似停滞 Agent
未追踪子 Agent
最近 5 分钟活动数
事件流延迟
```

### 8.2 中央 Agent 协作树

使用 SVG 或 Canvas 展示：

```text
manager-agent
├── requirement-agent       COMPLETED
├── architect-agent         RUNNING
│   ├── developer-agent     RUNNING
│   └── test-agent          WAITING_CHILD
└── review-agent            POSSIBLY_STALLED
```

每个节点显示：

- Agent ID 和角色。
- 当前 task/run/session。
- 当前动作。
- 最近安全输出摘要。
- 运行时长。
- 最近 heartbeat。
- 进度和 checkpoint。
- 子 Agent 数量。
- 状态可信度。

节点颜色：

```text
蓝色：RUNNING
灰色：COMPLETED
黄色：WAITING / POSSIBLY_STALLED
红色：BLOCKED / FAILED
紫色：SPAWNING_CHILD
黑色：UNTRACKED_CHILD
```

支持：

- 点击节点展开/折叠子树。
- 鼠标悬停显示当前动作。
- 点击节点打开详情抽屉。
- 只看运行中、只看异常、只看某个 Agent、只看某个 task。
- 高亮从某个 Agent 到其子 Agent 的输出链路。

### 8.3 右侧详情抽屉

借鉴 edict-main 的 TaskModal，详情抽屉包含：

1. Agent 身份、角色、父节点。
2. 当前 task/run/session/dispatch。
3. 当前任务描述和 checkpoint。
4. 最近安全输出流。
5. 最近工具调用摘要。
6. 最近 30 条活动。
7. 最近状态事件。
8. 子 Agent 列表和子 Agent 输出。
9. dispatch lease 和重试次数。
10. 停滞判断依据。
11. 可用的人工作业命令。

实时输出区域按以下形式显示：

```text
08:00:12  developer-agent  PROGRESS
已完成事件读取，开始构建节点关系

08:00:15  developer-agent  TOOL_FINISHED
shell · 1.2s · 已读取 12 个任务文件

08:00:18  test-agent  WAITING_CHILD
等待 developer-agent 输出可测试构建
```

### 8.4 任务活动时间线

按时间展示：

```text
任务创建
任务派发
Agent 启动
Agent 输出摘要
工具调用
子 Agent 创建
子 Agent 完成
人工审批
状态转换
Gate 结果
任务完成
```

支持时间范围、Agent、事件类型和来源筛选。

### 8.5 “偷懒”改为证据化健康状态

页面显示“疑似停滞”而不是直接显示“偷懒”。每个异常显示证据：

```text
疑似停滞
原因：task=RUNNING，最近 PROGRESS 为 7 分钟前，session 最近更新时间为 6 分钟前，输出目录没有变化。
可信度：MEDIUM
```

## 9. 状态、心跳和停滞判定

### 9.1 证据来源

状态投影器综合：

1. task 当前状态。
2. workflow 当前 phase/status。
3. dispatch receipt。
4. lease deadline。
5. explicit activity。
6. session JSONL 文件 mtime/updatedAt。
7. output/raw-logs 目录变化。
8. 可选的 Gateway/process probe。

进程存在只能说明“可能在线”，不能单独说明“正在推进任务”。

### 9.2 状态分类

| 状态 | 条件 |
|---|---|
| `RUNNING` | task 为 RUNNING，且最近活动不超过 45 秒 |
| `WAITING_HUMAN` | task/event/activity 明确等待人工 |
| `WAITING_CHILD` | Agent 明确等待子 Agent，且子任务仍未完成 |
| `BLOCKED` | task/event/activity 明确阻塞 |
| `NOT_STARTED` | dispatch 已创建，但没有 ACKNOWLEDGED/RUNNING |
| `STALE` | task 为 RUNNING，但 60 秒以上没有可靠活动 |
| `POSSIBLY_STALLED` | 超过任务类型阈值且连续没有 PROGRESS/checkpoint/output 变化 |
| `UNTRACKED_CHILD` | 发现 session 活动但没有合法 parent/child 记录 |
| `COMPLETED` | completion receipt 或完成事件已落盘 |
| `FAILED` | 失败回执或失败事件已落盘 |
| `UNKNOWN` | 数据缺失、冲突或无法判定 |

### 9.3 置信度

```text
HIGH：有明确结构化 activity 或 authoritative task/event
MEDIUM：task、dispatch 和 session/output 证据一致
LOW：只有 mtime、关键词或进程探测
UNKNOWN：证据冲突或数据缺失
```

建议阈值配置：

```text
config/monitoring.example.yaml
```

```yaml
heartbeat_timeout_seconds: 60
stalled_after_minutes: 5
not_started_after_seconds: 30
session_tail_interval_ms: 1000
snapshot_reconcile_interval_ms: 2000
max_activity_preview_chars: 500
max_tool_output_preview_chars: 300
```

Monitor 只报告疑似停滞，不自动重试或回滚。自动处理属于第二期 manager scheduler 能力，并必须复用已有状态机和 dispatch ledger。

## 10. Agent 输出与安全摘要协议

### 10.1 显式上报工具

新增：

```text
scripts/monitor-core/emit-activity.mjs
scripts/monitor-core/emit-checkpoint.mjs
```

Agent 在以下时机调用：

- 启动任务。
- 完成一个重要子步骤。
- 发起或完成工具调用。
- 创建子 Agent。
- 等待子 Agent/人工审批。
- 遇到阻塞。
- 完成或失败。

所有写入路径必须由当前 run 的 context manifest 传入，并由工具校验路径位于当前 artifact run 的 `output/monitor/` 内。

### 10.2 Session Tailer 兜底

如果 Agent 没有主动上报，Session Tailer 仍会从最近 JSONL 增量提取：

- assistant 的非 thinking 文本。
- tool_use 的工具名和开始事件。
- tool_result 的 exit code、耗时和短输出。
- user/manager 的派发或补充消息摘要。

不提取或不转发：

- `thinking` / chain-of-thought。
- 完整输入上下文。
- 系统 prompt。
- token、API key、cookie、环境变量。
- 未截断的 stdout/stderr。

### 10.3 脱敏规则

至少处理：

- API key、Bearer token、密码、cookie。
- `.env`、凭据文件和私钥路径。
- 绝对路径中的用户目录和敏感目录。
- 长 JSON、二进制内容和大段日志。
- 可识别的个人信息。

浏览器只收到 `USER_SAFE` 或 `INTERNAL_SUMMARY`，永远不直接读取原始 session JSONL。

## 11. 子 Agent 实时可见性方案

目标是：用户能在页面中看到子 Agent 的实时安全输出，并能沿父子关系追踪。

### 11.1 正常路径

```text
parent Agent
   │ sessions_spawn
   ├─ 预先创建 child task/run
   ├─ 记录 parent/child dispatch intent
   ├─ child session 写 activity 或被 Session Tailer 读取
   └─ Monitor 立即生成 child node + output stream
```

### 11.2 子 Agent 输出展示

每个子 Agent 节点都有独立输出流：

```text
GET /api/workflows/:workflowId/tasks/:taskId/activity
GET /api/workflows/:workflowId/agents/:agentId/activity
```

前端可以：

- 只看当前 Agent。
- 查看某个 Agent 的全部子树。
- 查看 parent→child 的实时输出关系。
- 把子 Agent 的最新摘要固定到父 Agent 详情页。
- 将子 Agent 的结构化 checkpoint 汇总到父任务进度条。

### 11.3 父 Agent 获取子 Agent 摘要

如果后续需要让父 Agent 也能实时消费子 Agent 状态，不把原始输出直接塞入父 Agent 上下文，而是提供结构化摘要：

```json
{
  "child_task_id": "TASK-child",
  "status": "RUNNING",
  "last_summary": "已完成接口定义，正在执行测试",
  "last_checkpoint": "API_SCHEMA",
  "last_activity_at": "...",
  "blocking_reason": null
}
```

manager 或父 Agent 通过安全的 child-status 查询读取，不读取完整 session 历史。

### 11.4 未追踪子 Agent

如果 Session Tailer 发现新的 session，但没有合法 task/dispatch 关系：

- UI 显示黑色 `UNTRACKED_CHILD` 节点。
- 显示 session key、Agent ID、最近安全输出摘要。
- 不自动把它归入某个 workflow。
- 生成 Monitor health warning。
- 第二期由 manager 处理登记或终止请求。

## 12. 用户交互和命令闭环

### 12.1 第一期开启的交互

- workflow 切换。
- Agent 树展开/折叠。
- 状态、Agent、task、事件类型过滤。
- 点击节点查看详情。
- 时间线定位。
- 复制安全摘要。
- 打开合法 artifact 路径。
- 手动重新加载/断线重连。

### 12.2 第二期命令请求

新增：

```text
contracts/monitor-command.schema.json
runtime/control/workflows/<workflow-id>/monitor-commands/
```

请求示例：

```json
{
  "schema_version": 1,
  "command_id": "CMD-...",
  "workflow_id": "WF-...",
  "task_id": "TASK-...",
  "run_id": "RUN-...",
  "target_agent_id": "developer-agent",
  "command": "NUDGE",
  "message": "请汇报当前进度和阻塞原因",
  "requested_by": "local-user",
  "requested_at": "...",
  "status": "REQUESTED"
}
```

支持的命令：

```text
NUDGE
SEND_MESSAGE
PAUSE_REQUEST
RESUME_REQUEST
CANCEL_REQUEST
RETRY_REQUEST
ESCALATE_REQUEST
```

流程：

```text
用户点击
   ↓
Monitor API 校验参数和权限
   ↓
写入 command request
   ↓
manager-agent 读取并验证 workflow/task/run/agent
   ↓
manager 调用 sessions_send 或 Runtime Guard 状态事务
   ↓
写入 command receipt
   ↓
Monitor 推送执行结果
```

Monitor 不直接执行 `sessions_send`、不直接写 `task.json`，这样仍然只有 manager 负责控制面变化。

## 13. 具体实施阶段

### Phase 0：基线和运行时探测

目标：确认 OpenClaw session 文件位置、Agent 配置字段和当前运行时规模。

工作：

1. 读取 install manifest 和 OpenClaw Agent 配置。
2. 确认每个 Agent 的 `agentDir`、workspace 和 session 目录。
3. 检查 session JSONL 的真实格式，确认 assistant/tool/thinking 字段。
4. 检查 `sessions_spawn` 返回的 session 标识和父子关系可见字段。
5. 对现有 workflow 统计 task、run、dispatch、事件数量。
6. 输出 `docs/plan/monitor-runtime-baseline.md`。

验收：不修改 OpenClaw 配置，不修改 workflow，不读取或保存完整敏感 session 内容。

### Phase 1：只读 Monitor MVP 后端

新增：

```text
monitor/server.mjs
monitor/event-source.mjs
monitor/snapshot-projector.mjs
monitor/activity-classifier.mjs
monitor/event-hub.mjs
monitor/file-watcher.mjs
monitor/redactor.mjs
```

实现：

1. 读取 active workflow。
2. 读取 task、event、dispatch 和现有 artifact。
3. 构建 Agent/task/run/session 节点。
4. 生成状态、健康证据、父子边和最近活动。
5. 提供快照、历史事件和 SSE。
6. 支持断线后的 sequence 回放。
7. 监控错误不阻塞 workflow。

验收：没有 activity 文件时，仍能用现有文件显示基本状态。

### Phase 2：活动协议和实时输出

新增：

```text
contracts/agent-activity.schema.json
contracts/agent-live-status.schema.json
contracts/agent-checkpoint.schema.json
scripts/monitor-core/emit-activity.mjs
scripts/monitor-core/emit-checkpoint.mjs
scripts/monitor-core/session-tailer.mjs
scripts/monitor-core/session-parser.mjs
templates/agent-activity.json
templates/agent-live-status.json
templates/agent-checkpoint.json
```

修改：

```text
agents/common/CONTEXT_PROTOCOL.md
agents/common/COMMON_RULES.md
agents/*/workspace/AGENTS.md
agents/*/workspace/TOOLS.md
```

实现双通道：

```text
显式 emit-activity → 高精度结构化状态
Session Tailer      → 没有主动上报时的安全输出兜底
```

验收：子 Agent 的安全文本、工具状态、短输出可以在 1～2 秒内出现在 Dashboard；`thinking` 不出现在 API 和 UI。

### Phase 3：图形化 Dashboard

第一期可使用原生 HTML/CSS/JS，等交互复杂度稳定后再使用 React/Vite。建议目录：

```text
monitor/ui/index.html
monitor/ui/app.js
monitor/ui/styles.css
monitor/ui/components/agent-tree.js
monitor/ui/components/activity-feed.js
monitor/ui/components/task-drawer.js
monitor/ui/components/timeline.js
```

实现：

1. 顶部健康摘要。
2. SVG Agent 树。
3. Agent 状态卡片。
4. 子 Agent 实时输出面板。
5. Task 详情抽屉。
6. 时间线和过滤器。
7. 疑似停滞证据提示。
8. SSE 断线重连。
9. 空状态、旧 workflow 降级状态和监控异常提示。

### Phase 4：命令闭环

新增：

```text
contracts/monitor-command.schema.json
monitor/command-api.mjs
monitor/command-receipt-reader.mjs
```

修改 manager 规则和文档，使 manager 读取并处理 monitor command request。

第一批命令只做：

```text
NUDGE
SEND_MESSAGE
PAUSE_REQUEST
```

验证命令处理、用户确认、幂等、审计、失败回执和恢复。

### Phase 5：可追踪的任意层级 Subagent

只有 Phase 1～4 稳定后才考虑开放非 manager Agent spawn。

工作：

1. 扩展 dispatch intent 父子字段。
2. 扩展 task/run 创建规则。
3. 允许列表和 Agent prompt 增加 tracked spawn 协议。
4. 对 raw spawn 做拒绝或 `UNTRACKED_CHILD` 标记。
5. 测试至少三层 Agent 树。
6. 验证 parent/child 输出、完成回执和失败恢复。

### Phase 6：规模化事件基础设施

在以下情况出现前，不引入 Redis/Postgres：

- workflow 数量和并发 Agent 数量超过本地文件投影能力。
- session JSONL 尾读成为性能瓶颈。
- 需要多台机器共享 Monitor。
- 需要长期统计、成本分析和跨实例订阅。

届时实现 EventBusAdapter，将本地 JSONL 事件复制到 Redis Streams/NATS，并保持同一 Event Envelope。

## 14. 计划修改的文件清单

### 新增

```text
docs/plan/2026-08-04-agent-observability-monitor.md
contracts/agent-activity.schema.json
contracts/agent-live-status.schema.json
contracts/agent-checkpoint.schema.json
contracts/monitor-command.schema.json
templates/agent-activity.json
templates/agent-live-status.json
templates/agent-checkpoint.json
config/monitoring.example.yaml
monitor/server.mjs
monitor/event-source.mjs
monitor/event-hub.mjs
monitor/file-watcher.mjs
monitor/snapshot-projector.mjs
monitor/activity-classifier.mjs
monitor/session-tailer.mjs
monitor/session-parser.mjs
monitor/redactor.mjs
monitor/ui/index.html
monitor/ui/app.js
monitor/ui/styles.css
monitor/ui/components/agent-tree.js
monitor/ui/components/activity-feed.js
monitor/ui/components/task-drawer.js
monitor/ui/components/timeline.js
scripts/monitor-core/emit-activity.mjs
scripts/monitor-core/emit-checkpoint.mjs
scripts/monitor-core/session-tailer.mjs
scripts/monitor-core/session-parser.mjs
scripts/monitor-core/redactor.mjs
tests/monitor-snapshot.test.mjs
tests/monitor-activity.test.mjs
tests/monitor-classifier.test.mjs
tests/monitor-session-tailer.test.mjs
tests/monitor-http.test.mjs
tests/fixtures/monitor-parent-child/
```

### 修改

```text
package.json
contracts/task.schema.json
contracts/dispatch-intent.schema.json（如果当前已有独立契约）
scripts/runtime-guard.mjs（只增加必要的契约/路径校验）
agents/common/CONTEXT_PROTOCOL.md
agents/common/COMMON_RULES.md
agents/*/workspace/AGENTS.md
agents/*/workspace/TOOLS.md
docs/architecture.md
docs/state-and-recovery.md
docs/manager-orchestration.md
README.md
CHANGELOG.md
docs/current-progress-assessment.md
```

所有修改应先在独立分支实施，并沿现有 workflow、Runtime Guard、Ajv 和安装验证流程验收。

## 15. 测试和验收方案

### 15.1 契约测试

- Ajv 校验所有新增 JSON/JSONL schema。
- `live-status.json` 原子写入，不出现半截 JSON。
- `activity.jsonl` 末尾半行不会导致 Monitor 崩溃。
- 不允许 activity 写到当前 run 之外的目录。
- 事件 Envelope 的 ID 关联必须一致。

### 15.2 投影测试

至少覆盖：

1. manager → worker。
2. manager → worker → child。
3. 三层 child tree。
4. 多次 retry 的同 Agent、多 run。
5. waiting human。
6. waiting child。
7. blocked/failed/completed。
8. 没有 activity 文件的旧 workflow。
9. session tailer 发现未追踪 child。
10. session JSONL 中包含 thinking、tool_use、tool_result，确认只保留安全字段。
11. 父子 task 关系缺失时标记 inferred。
12. `events.jsonl` 哈希链未被改写。

### 15.3 实时性测试

目标：

| 指标 | MVP 目标 |
|---|---:|
| activity 文件到 API | ≤ 1 秒 |
| API 到已连接浏览器 | ≤ 2 秒 |
| SSE 断线重连 | ≤ 3 秒恢复 |
| 单 workflow 快照生成 | ≤ 500ms |
| 100 个 Agent 树渲染 | ≤ 2 秒可交互 |
| 单个 workflow 最近事件保留 | 至少 500 条或最近 30 分钟 |
| 监控服务空闲 CPU | 本地开发机目标 < 5% |

### 15.4 安全测试

- 原始 thinking 不出现在 API 响应。
- 密钥、token、cookie、私钥不出现在输出摘要。
- 任意路径访问被拒绝。
- Monitor 默认不能写控制文件。
- command API 拒绝未授权 Agent/task/run 组合。
- 事件链被篡改时页面显示 `monitor-health=DEGRADED`，不自行修复历史。

### 15.5 用户验收场景

用一个实际 workflow 演示：

1. manager 创建 developer task。
2. developer 开始工作并写入活动。
3. developer 创建 child task。
4. child session 开始输出安全摘要。
5. 页面出现 child 节点和 parent-child 连线。
6. child 工具调用和短输出实时出现。
7. child 等待输入时显示 `WAITING_CHILD` 或 `WAITING_HUMAN`。
8. 让一个 Agent 停止更新，页面显示“疑似停滞”和证据。
9. child 完成后 parent 页面显示 child completion 摘要。
10. workflow 完成后所有节点进入终态，时间线可回放。

## 16. 性能和可靠性策略

借鉴 edict-main 的“性能基线单独记录”做法，新增：

```text
docs/plan/monitor-runtime-baseline.md
docs/plan/monitor-performance-report.md
```

Monitor 性能策略：

1. 只尾读发生变化的 session JSONL。
2. 对每个 session 保存 byte offset，避免重复解析。
3. 对 workflow snapshot 做短 TTL 缓存。
4. 文件变化采用 debounce，避免一次写入触发多次推送。
5. SSE 只推送增量事件，初次连接才发送完整 snapshot。
6. 浏览器只保留最近 N 条实时输出，历史按需请求。
7. 事件读取失败时保留上一个有效快照并显示降级原因。
8. Monitor 进程重启后从文件和 sequence 重新构建，不依赖内存状态。
9. 不把完整 session 历史复制进内存或发送到客户端。

## 17. 回滚和失败处理

本改造应具备独立回滚能力：

- 停止 `npm run monitor` 不影响 Agent 工作流。
- 移除 Agent activity 上报规则后，旧 workflow 仍能运行。
- 新增 schema 不应改变已有 schema 的合法数据。
- Session Tailer 失败时退回 task/event/dispatch 基础状态。
- SSE 失败时前端退回手动刷新/轮询快照。
- Monitor 读取异常只显示 DEGRADED，不改写、不修复控制文件。
- command request 失败不会改变任务状态，保留失败 receipt。

## 18. 推荐实施顺序和里程碑

| 里程碑 | 内容 | 结果 |
|---|---|---|
| M0 | 运行时和 session 格式探测 | 明确真实路径和字段，形成 baseline |
| M1 | 只读 snapshot + API + SSE | 能看到现有 workflow/task/dispatch |
| M2 | activity 协议 + Session Tailer | 能看到 Agent 安全实时输出 |
| M3 | 图形化 Agent 树、详情和时间线 | 用户可实时观察和筛选 |
| M4 | 健康判定和疑似停滞证据 | 能发现长时间无进展 Agent |
| M5 | command request 闭环 | 用户可催办、暂停、发送消息 |
| M6 | tracked multi-level subagent | 子 Agent 可审计、可见、可回放 |
| M7 | EventBus adapter | 为多实例和大规模部署准备 |

建议第一期优先完成 M0～M4，形成可独立运行的轻量监测平台。M5 以后再扩大权限和引入更重的基础设施。

## 19. 最小 MVP 交付定义

以下项目全部满足后，第一期即可交付：

- 本地启动一个 Monitor 服务。
- 浏览器能看到当前 workflow 的 Agent 树。
- 能显示 manager、worker 和 child Agent。
- 能实时显示安全文本、工具调用状态和短输出。
- 不显示完整 thinking。
- 能显示 heartbeat、当前动作、checkpoint 和最近活动。
- 能显示等待、阻塞、完成和疑似停滞。
- 子 Agent 输出可以单独查看，也可以从父 Agent 详情页进入。
- SSE 断线后可按 sequence 回放。
- 旧 workflow 兼容降级显示。
- Monitor 不改变原有控制面权限和事件链。
- 完成 schema、单元、集成、实时性和安全测试。

这条路线兼顾了 edict-main 已验证的实时看板、活动解析、心跳判断和人工干预思路，也保留当前项目文件化状态、Runtime Guard、append-only 证据和 manager 唯一编排者边界。第一期不需要先重构整个系统，就能让用户实时看到包括子 Agent 在内的协作过程和安全输出。

