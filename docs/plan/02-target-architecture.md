# 02 · 目标分层架构设计

> 本文档定义重构后的目标架构。设计原则：**贴合现状**。目标架构里的每一层，都尽量落在现有文件上，而不是另起一套。

---

## 1. 目标运行链路

```text
User / Manager CLI / API
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│ Control Kernel  ── 唯一可信数据源（Single Source of Truth） │
│   run / task / execution / artifact / event                │
│   PostgreSQL schema: kernel                                │
└────────────────────────────────────────────────────────────┘
        │  ① 建 run + 分配 langgraph_thread_id
        ▼
┌────────────────────────────────────────────────────────────┐
│ LangGraph Runtime                                          │
│   StateGraph（唯一状态机，决策语义）                        │
│   节点：Manager / Requirement / Architect / Developer /     │
│         Tester / Reviewer / Ops                            │
└────────────────────────────────────────────────────────────┘
        │  ② decide() → Control Kernel Dispatch
        ▼
┌────────────────────────────────────────────────────────────┐
│ Control Kernel Dispatch                                    │
│   领 lease → 写 execution 行 → 交给 Harness                │
└────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│ Agent Harness（进程边界 + 心跳 + 超时 + 证据落盘）          │
└────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│ OpenClaw Agent / Worker                                    │
│   LLM · Tools · Skills · Workspace · Sandbox               │
└────────────────────────────────────────────────────────────┘
        │  raw stdout / result.json.raw
        ▼
┌────────────────────────────────────────────────────────────┐
│ JSON Harness  →  Schema Validation（Ajv + contracts/）      │
└────────────────────────────────────────────────────────────┘
        │  ③ 校验通过
        ▼
┌────────────────────────────────────────────────────────────┐
│ Artifact Store：Git worktree + CAS（sha256 内容寻址）       │
└────────────────────────────────────────────────────────────┘
        │  ④ Kernel 写 execution 终态 + artifact 行
        ▼
┌────────────────────────────────────────────────────────────┐
│ StateGraph State Update                                    │
└────────────────────────────────────────────────────────────┘
        │  ⑤
        ▼
┌────────────────────────────────────────────────────────────┐
│ LangGraph Checkpointer  →  PostgreSQL schema: langgraph     │
└────────────────────────────────────────────────────────────┘
```

### 关键约束：写入顺序恒定

```text
Control Kernel 落库（事实）  →  Checkpoint 落库（决策投影）
```

顺序不可颠倒。含义：Kernel 里可能存在「已完成但 checkpoint 还没投影」的执行 —— 这是**可恢复**的，重启后 `reconcile` 会读 Kernel 补投影。反过来「checkpoint 说完成但 Kernel 没记录」是**不可恢复**的脏状态。所以永远先写 Kernel。

---

## 2. 层与现有文件的映射

这张表是整个重构的施工图。**"新建"只有 6 个文件**，其余全是在现有文件上扩展。

| 目标层 | 现有落点 | 处理方式 |
| --- | --- | --- |
| **Control Kernel** | 无（`scripts/control-core/` 是空目录） | **新建** `scripts/control-kernel/`：`schema.sql` / `pool.mjs` / `repository.mjs` / `kernel.mjs` / `lease.mjs` |
| **LangGraph Runtime** | `scripts/stategraph/runtime.mjs` (111 行) | 扩展：注入 `kernel`，`list()` 改走 Kernel |
| **StateGraph** | `scripts/stategraph/graph.mjs` (583 行) | 扩展：节点内加 Kernel 写入；新增 `split_tasks` / `merge_tasks` 直通节点 |
| **状态通道** | `scripts/stategraph/state.mjs` (40 行) | 扩展：新增 `runId` / `taskGroups` / `parallelism` 通道 |
| **Control Kernel Dispatch** | `graph.mjs` 的 `decide()` 节点 | 扩展：`action='dispatch'` 前先 `kernel.acquireLease()` |
| **Agent Harness** | `scripts/stategraph/dispatcher.mjs` (219 行) + `agent-runner.mjs` (147 行) | 扩展：`start()` 写 execution 行；`agent-runner.mjs` 周期性 `heartbeat` |
| **JSON Harness** | `scripts/stategraph/output-ingestion.mjs` (254 行) | 基本不动，只在成功后回写 artifact 行 |
| **Schema Validation** | `contracts/*.json` (22 个) + Ajv | 不动；新增 3 个 kernel 相关 schema |
| **Artifact Store** | `scripts/stategraph/git-worktree.mjs` (118 行) | 扩展：新增 `scripts/control-kernel/cas.mjs` |
| **Checkpointer** | `scripts/stategraph/sqlite-checkpointer.mjs` (149 行) | **替换**为 `postgres-checkpointer.mjs` |
| **DB 连接** | `scripts/stategraph/database.mjs` (11 行) | **替换**为 `scripts/control-kernel/pool.mjs` |
| **Monitor** | `monitor/*.mjs` (12 文件) | 数据源切 Kernel；**HTTP 契约与 UI 零改动** |

---

## 3. 三种状态的职责切分

用户给的图把状态分成三类。这是本次重构最重要的概念约束，逐条落地：

### 3.1 Workflow State → StateGraph + LangGraph Checkpointer

**存放什么**：路由决策、阶段进度、审批语义。即 `state.mjs` 现有的全部通道。

**存到哪**：PostgreSQL `langgraph.checkpoints` / `langgraph.checkpoint_writes`。

**谁能写**：只有 StateGraph 节点返回的 patch。

**为什么不放 Kernel**：这些是「LangGraph 认为的世界」，是可重放、可回滚的决策记录，和「客观发生过什么」不是一回事。

### 3.2 Execution State → Control Kernel + PostgreSQL

**存放什么**：`worker_id` / `heartbeat_at` / `lease_expires_at` / `attempt` / `pid` / `exit_code`。

**存到哪**：PostgreSQL `kernel.executions`。

**谁能写**：只有 Control Kernel（Harness 通过 Kernel API 间接写）。

**为什么必须独立**：这是**客观事实**，不能因为 checkpoint 回滚而消失。一个 Agent 进程真的跑过、真的写了文件、真的可能还活着 —— 这些事实必须有一份不受 workflow 决策影响的记录。否则崩溃恢复时无法判断「这个 worker 还在不在」。

### 3.3 Artifact State → Git + CAS

**存放什么**：`artifact_id` / `uri` / `sha256` / `size_bytes` / `media_type`。

**存到哪**：内容在 `runtime/cas/<sha256前2位>/<sha256>`，索引在 `kernel.artifacts`。

**谁能写**：只有 JSON Harness 校验通过之后。

**为什么用 CAS**：同一份产物可能被多个 run 引用（例如同一份需求文档被两轮开发复用）。内容寻址天然去重，且 hash 就是完整性校验。

---

## 4. Control Kernel 的职责边界

### 4.1 Kernel 负责（唯一可信）

1. **Run 生命周期**：创建 run、分配 `langgraph_thread_id`、维护 run 终态
2. **Task 台账**：task 的存在性、类型、所属 run、依赖关系
3. **Execution 事实**：worker 身份、心跳、lease、attempt、退出码
4. **Artifact 索引**：artifact_id ↔ uri ↔ hash
5. **Lease 仲裁**：保证同一 task 同时只有一个活跃 execution
6. **孤儿回收**：扫描 `lease_expires_at < now()` 且 `state='RUNNING'` 的 execution，标记 `LEASE_EXPIRED`
7. **事件账本**：`kernel.events` 的哈希链，`prev_hash` 串联

### 4.2 Kernel 不负责

1. **不做路由决策**。「下一步该走哪个阶段」永远是 StateGraph 的事。Kernel 只记录「StateGraph 让我派发了什么」。
2. **不解析 Agent 输出**。那是 JSON Harness 的事。
3. **不做审批判定**。审批语义在 `state.pendingApproval`，Kernel 只记录审批事件发生过。
4. **不托管 prompt**。prompt 仍由 `graph.mjs` 的 `createTask()` 组装。

> 这条边界的意义：Kernel 保持"薄"。它是账本，不是大脑。大脑只有一个，是 StateGraph。

### 4.3 Kernel API 契约

`scripts/control-kernel/kernel.mjs` 对外只暴露这些方法（全部 async）：

```js
createKernel({ pool, clock, workerId })
// Run
  createRun({ runId, threadId, request, targetProjectRoot, baseCommit })
  getRun(runId) / getRunByThreadId(threadId)
  listRuns({ states, limit })
  completeRun(runId, { outcome, statusReason })
// Task
  upsertTask({ runId, taskId, kind, stepId, title, agentId, taskGroupId, parallelSlot, dependsOn })
  getTask(taskId) / listTasks(runId)
  setTaskState(taskId, state, { lastError })
// Execution
  acquireLease({ taskId, attempt, workerId, leaseSeconds })   // 唯一并发闸门
  heartbeat(executionId, { phase })
  releaseLease(executionId, { state, exitCode, error })
  reapExpiredLeases({ now })
  activeExecution(taskId)
// Artifact
  putArtifact({ runId, taskId, executionId, kind, uri, sha256, sizeBytes, mediaType })
  listArtifacts({ runId, taskId })
// Event
  appendEvent({ runId, taskId, executionId, type, payload })   // 内部算 prev_hash
  auditEvents(runId)
// 只读投影（Monitor 专用）
  projectRuns({ limit })
  projectRun(runId)
```

**`acquireLease` 是整个 Kernel 的核心。** 它必须在单条 SQL 事务内完成「检查无活跃 lease + 插入新 execution」，否则并发下会出现两个 worker 同时跑一个 task。实现见 [`03-postgres-data-model.md`](./03-postgres-data-model.md) §5。

---

## 5. StateGraph 改造：最小侵入

现有 13 个节点全部保留，路由结构（每个节点 `addEdge(node, END)`，`decide` 中心分发）**完全不变**。改造只有三类：

### 5.1 节点内追加 Kernel 写入

| 节点 | 追加动作 |
| --- | --- |
| `initialize` | `kernel.createRun({ runId, threadId: workflowId, ... })` |
| `prepare_manager` / `prepare_step` | `kernel.upsertTask({ ... })` |
| `dispatch` | `kernel.acquireLease()` → 成功才调 `dispatcher.start()` |
| `reconcile` | `kernel.heartbeat()` 或读 Kernel 判定 `LEASE_EXPIRED` |
| `evaluate` | `kernel.putArtifact()` + `kernel.setTaskState()` |
| `complete` / `finish` | `kernel.completeRun()` |
| `apply_human` | `kernel.appendEvent({ type: 'HUMAN_DECISION' })` |
| `integrity_hold` | `kernel.appendEvent({ type: 'INTEGRITY_HOLD' })` |

**写法约束**：Kernel 调用一律放在节点函数**最前面**（写事实），patch 返回放在**最后**（写决策）。这样即使 patch 因为异常没返回，Kernel 的事实也已落库，恢复时能补。

### 5.2 `reconcile` 新增 lease 过期分支

现有 `dispatcher.reconcile()` 返回四种 kind：`WAITING` / `JSON_REPAIR` / `ERROR` / `SUCCEEDED`。

**新增第五种**：`LEASE_EXPIRED`。触发条件：`result.kind === 'WAITING'` 但 `kernel.activeExecution(taskId)` 显示 lease 已过期。处理方式复用现有 `failurePatch()`，`error.code = 'EXECUTION_LEASE_EXPIRED'`，自动走 attempt 重试预算。

这是 Kernel 带来的**唯一新行为**：以前 Agent 进程静默死掉会让 workflow 永久卡在 `RUNNING`，现在会被 lease 超时兜住。

### 5.3 `dispatch` 新增 lease 争抢失败分支

`acquireLease` 抛 `LEASE_HELD` 时，复用现有 `SANDBOX_GLOBAL_BUSY` 的处理路径（记事件、`stopReason='DISPATCH_DEFERRED'`、不消耗 attempt）。串行模式下这个分支实际不会触发，但接口必须在，否则并行扩展时要改核心逻辑。

---

## 6. 核心流程（串行）

严格对应用户给的流程图，用现有 `policy.ORDER` 表达：

```text
User / Manager CLI
      │
      ▼
Manager / Initial Router          ← MANAGER_ANALYSIS，产出 route-plan
      │
      ▼
Requirement                       ← REQUIREMENTS
      │
      ▼
Architect                         ← ARCHITECTURE（+ 可选 DESIGN）
      │
      ▼
Human Approval                    ← pendingApproval，condition=WAITING_HUMAN
      │
      ▼
Developer                         ← DEVELOPMENT
      │
      ▼
Tester                            ← TEST
      ├── FAIL   ──────────────► Developer（executionRound + 1）
      └── PASS
             │
             ▼
      Reviewer                    ← CODE_REVIEW
             ├── REJECT ────────► Developer / Architect
             └── APPROVE
                    │
                    ▼
                  Ops             ← RELEASE
                    │
                    ▼
                   END
```

### 与现有 `policy.ORDER` 的关系

现有常量：

```js
ORDER = ['REQUIREMENTS','ARCHITECTURE','DESIGN','DEVELOPMENT','CODE_REVIEW','TEST','RELEASE']
```

注意 `ORDER` 里 `CODE_REVIEW` 在 `TEST` **之前**，而用户流程图是 `Tester → Reviewer`。

**处理方式**：不改 `ORDER`。`ORDER` 只用于 `assertRouteRules()` 的合法性校验（保证不倒序、DEVELOPMENT 后必须有 TEST），**实际执行顺序由 Manager 生成的 `route_plan.steps` 数组决定**。Manager 可以自由产出 `[..., DEVELOPMENT, TEST, CODE_REVIEW, RELEASE]`。

这一点必须在 `agents/manager-agent/workspace/AGENTS.md` 里写清楚：**推荐顺序为 DEVELOPMENT → TEST → CODE_REVIEW → RELEASE**，让 Reviewer 能看到测试结果再评审。

### 回退（FAIL / REJECT）的实现

已有机制，不需要新代码：`route_plan.steps` 里同一 `kind` 可以出现多次，用 `execution_round` 区分。回退 = Manager 在 `revise()` 时追加一个 `execution_round: 2` 的 DEVELOPMENT step。`createTask()` 已经支持（`taskId` 后缀是 `${stepId}-R${executionRound}`）。

---

## 7. 并行预留接口（本次不启用）

用户要求「不加入并行 agent，但保留接口」。设计原则：**接口全部到位并有测试覆盖，开关默认关闭。**

### 7.1 数据层预留（表字段已在 DDL 中）

```sql
kernel.tasks.task_group_id   TEXT              -- 同一 group 内可并行
kernel.tasks.parallel_slot   INTEGER NOT NULL DEFAULT 0
kernel.tasks.depends_on      TEXT[] NOT NULL DEFAULT '{}'
```

串行模式下：`task_group_id = task_id`，`parallel_slot = 0`，`depends_on = 前一个 task_id`。**串行是并行的退化情形**，不是特例分支。

### 7.2 图层预留（两个直通节点）

```text
prepare_step ──► split_tasks ──► dispatch ──► reconcile ──► merge_tasks ──► evaluate
```

`split_tasks` 与 `merge_tasks` 在 `policy.parallelism.enabled === false` 时是**纯直通**：

```js
splitTasks(state) {
  if (!dependencies.policy.parallelism?.enabled) return { action: 'dispatch' };
  // 并行分支：按 route step 的 split_hint 拆多个 task，同 task_group_id，
  //          parallel_slot 递增，一次性 upsertTask 后逐个 acquireLease
  throw Object.assign(new Error('parallel split not implemented'),
    { code: 'PARALLEL_NOT_IMPLEMENTED' });
}

mergeTasks(state) {
  if (!dependencies.policy.parallelism?.enabled) return { action: 'evaluate' };
  // 并行分支：等同 group 全部 SUCCEEDED → 合并 worktree → 单一 candidateCommit
  throw Object.assign(new Error('parallel merge not implemented'),
    { code: 'PARALLEL_NOT_IMPLEMENTED' });
}
```

**为什么现在就加这两个空节点**：LangGraph 的 `addConditionalEdges` 映射表是静态的。现在加进去，将来只改节点函数体，不动图结构 —— 而动图结构会让所有已存在的 checkpoint 失效。

### 7.3 Lease 层预留

`acquireLease` 的唯一性约束建在 `(task_id)` 上而不是 `(run_id)` 上：

```sql
CREATE UNIQUE INDEX kernel_executions_active_lease
  ON kernel.executions(task_id) WHERE state IN ('LEASED','RUNNING');
```

即：**一个 task 一个活跃 execution，但一个 run 可以有多个活跃 execution**。串行模式靠 StateGraph 只产生一个 active task 来保证串行，而不是靠数据库约束。打开并行开关时数据库层不需要任何改动。

### 7.4 Policy 预留

```json
"parallelism": {
  "enabled": false,
  "max_concurrent_tasks": 1,
  "merge_strategy": "SEQUENTIAL_REBASE"
}
```

### 7.5 Worker 池预留

`kernel.executions.worker_id` 现在恒等于 `${hostname}-${pid}`（单进程）。将来多 worker 时改为从 `OPENCLAW_WORKER_ID` 读取，**表结构与 API 都不变**。

---

## 8. Monitor 保留方案

用户明确要求保留监测功能与 UI。**这是硬约束，冻结契约。**

### 8.1 冻结的 19 个 HTTP 端点

| # | 方法 | 路径 | 冻结点 |
| --- | --- | --- | --- |
| 1 | GET | `/` | HTML |
| 2 | GET | `/index.html` | HTML |
| 3 | GET | `/styles.css` | CSS |
| 4 | GET | `/app.js` | JS |
| 5 | GET | `/config.js` | JS |
| 6 | GET | `/api/client-config` | `source:'LANGGRAPH_CHECKPOINTS'`、`mode:'READ_ONLY'` |
| 7 | GET | `/api/health` | `{ ok, status, api_reachable, sequence, audit, generated_at }` |
| 8 | GET | `/api/workflows` | `{ ok, workflows[], generated_at, source }` |
| 9 | GET | `/api/supervisor` | `{ ok, enabled:false, mode:'READ_ONLY' }` |
| 10 | GET | `/api/agents` | `{ ok, agents[] }` |
| 11 | GET | `/api/agents/:id/sessions` | `{ ok, agent_id, sessions[] }` |
| 12 | GET | `/api/agents/:id/sessions/:sid/messages` | `{ ok, session, truncated, messages[] }` |
| 13 | GET | `/api/workflows/:id/snapshot` | `{ ok, snapshot }` |
| 14 | GET | `/api/workflows/stream` | SSE，首帧 `type:'snapshot'` |
| 15 | GET | `/api/workflows/:id/stream` | SSE，首帧过滤单 workflow |
| 16 | GET | `/api/tasks/:id` | `{ ok, task }` |
| 17 | GET | `/api/tasks/:id/activity` | `{ ok, dialogue[] }` |
| 18 | GET | `/api/tasks/:id/health` | `{ ok, health }` |
| 19 | OPTIONS | `*` | 204 |

同时冻结：loopback-only（403 `LOOPBACK_ONLY`）、GET-only、origin 白名单、`protocol_version: 'stategraph-checkpoint-v1'`。

### 8.2 冻结的 read model 字段

`publicWorkflow` 22 个字段、`publicTask` 15 个字段、`publicDispatch` 8 个字段，**字段名与语义全部不变**。

允许**追加**的新字段（UI 不读则无影响）：

```js
// publicWorkflow 追加
run_id: run.run_id,
langgraph_thread_id: run.langgraph_thread_id,

// publicTask 追加
execution: {
  execution_id, worker_id, state,
  heartbeat_at, lease_expires_at, attempt,
},
artifacts: [{ artifact_id, kind, uri, sha256 }],
task_group_id, parallel_slot,   // 并行预留，串行下恒为 task_id / 0
```

### 8.3 数据源切换 + 回退

`monitor/server.mjs` 的 `refresh()` 改为**双源合并**：

```text
主源：kernel.projectRuns()        ← Execution/Artifact 事实
副源：stateRuntime.list()          ← Workflow 决策语义（route/approval/steps）
合并键：run.langgraph_thread_id === state.workflowId
```

**回退策略**：若 Kernel 不可达（PG 连接失败），`refresh()` 降级为纯 `stateRuntime.list()`，并在 `/api/health` 返回 `status:'DEGRADED'` + `kernel_reachable:false`。**UI 仍然可用**，只是 `execution` / `artifacts` 字段为 `null`。

这个降级路径必须有测试覆盖（P8）。

### 8.4 Telemetry 数据库不迁移

`monitor/telemetry-repository.mjs` 的 6 张表（`monitor_events` / `agent_activities` / `session_cursors` / `artifact_cursors` / `agent_health_snapshots` / `redaction_audit`）**继续用 `node:sqlite`**，存 `runtime/monitor/monitor.db`。

理由：

1. Telemetry 是**可丢弃的观测数据**，不是可信数据源。丢了重新 tail session 文件就能重建。
2. Monitor 必须能在 PG 挂掉时独立运行（见 8.3 降级）。
3. 迁移它没有任何收益，只增加 PG 的写压力和一个新的失败点。

**这是一个明确的设计决定，不是遗漏。**

---

## 9. 生产部署结构

```text
┌──────────────────────────────────────────────────────────────┐
│ API Server (scripts/api-server.mjs, P9 可选)                  │
│   或 Manager 请求队列 (manager-request-queue.mjs, 现有)        │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────┐
│ Control Kernel（唯一可信数据源）                              │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────┐
│ LangGraph StateGraph                                         │
└──────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
    Worker 1    Worker 2    Worker N     ← 本次只有 Worker 1
        │           │           │
        └───────────┼───────────┘
                    ▼
              OpenClaw Agent
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
       LLM         Git        Tools
```

### 存储层

| 组件 | 本次落地 | 备注 |
| --- | --- | --- |
| PostgreSQL `kernel` schema | ✅ | Run/Task/Execution/Artifact/Event |
| PostgreSQL `langgraph` schema | ✅ | checkpoints/checkpoint_writes |
| Artifact Store | ✅ | `runtime/cas/` + Git worktree |
| SQLite `monitor.db` | ✅ 保留 | Telemetry，见 §8.4 |
| Redis | ❌ 不引入 | lease 已用 PG 行锁实现，够了 |

**为什么不引入 Redis**：用户的图里有 Redis，但在串行单 worker 下它没有职责 —— lease 仲裁 PG 能做且更可靠（事务保证），事件分发 Monitor 已有 `MonitorEventHub`（进程内）。引入 Redis 只增加一个运维组件和一个失败点。**多 worker 跨进程时再引入**，届时 `MonitorEventHub` 换成 Redis pub/sub 即可，接口不变。

---

## 10. 不可变约束（继承 + 新增）

以下约束在重构中**一条都不能破**：

### 继承自现有架构

1. **StateGraph 是唯一状态机**，不得出现第二个状态机
2. **双 capability 授权**，timing-safe compare
3. **哈希事件链**：canonical JSON + `previous_event_hash`，`audit()` 可重放
4. **route_hash 冻结**：`verifyFrozenRoute()` 失败即 `integrity_hold`
5. **两层重试预算**：attempt 3 次 + JSON 重生成 2 次
6. **TEST 阶段强制 Docker 沙箱** attestation + 全局 bind lease
7. **detached worktree 每 run 隔离** + commit ancestry 校验
8. **workflow 单写锁**：原子 `wx` + stale 检查
9. **Monitor 只读**、loopback-only、GET-only
10. **Agent 环境剥离** capability 环境变量

### 本次新增

11. **写入顺序**：Kernel 先，Checkpoint 后，不可颠倒
12. **Kernel 保持薄**：不做路由决策、不解析输出、不判审批
13. **Monitor 契约冻结**：19 端点 + 3 read model 只追加不删改
14. **Monitor 可降级**：PG 不可达时 UI 仍可用
15. **串行是并行的退化情形**，不是特例分支
16. **Telemetry 不上 PG**
