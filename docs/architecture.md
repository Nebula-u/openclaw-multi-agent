# Control Kernel + PostgreSQL 分层架构

> 更新日期：2026-08-18
> 对应分支：`workbuddy/control-kernel-postgres`（P0–P10 已完成）

## 设计结论

系统由两层权威构成，职责不重叠：

- **Control Kernel（唯一可信数据源）** —— 记录客观事实：run、task、execution、artifact、event。存 PostgreSQL `kernel` schema。
- **LangGraph StateGraph（唯一状态机）** —— 记录决策语义：路由、阶段进度、审批。经 checkpointer 存 PostgreSQL `langgraph` schema。

原 SQLite checkpointer（`sqlite-checkpointer.mjs`）与 `database.mjs` 已删除，运行时不再有 SQLite 状态源；Monitor telemetry 是唯一保留的 SQLite，它是可丢弃的观测数据，不是权威（理由见 §Monitor）。

重建基点仍为 `ef850ce6e8b71391203460f28670b1d85eb72c72`（位于已知混淆 JavaScript 引入之前），本次重构在该基线上以 `49e9143` 为分支起点分 P0–P10 增量实施。

## 运行链路

```text
User / Manager CLI
        |
        v
Control Kernel  ── 唯一可信数据源（PostgreSQL schema: kernel）
   run / task / execution / artifact / event
        |  (1) 建 run + 绑定 langgraph_thread_id
        v
LangGraph StateGraph  ── 唯一状态机
   Manager / Requirement / Architect / Developer / Tester / Reviewer / Ops
        |  (2) decide() -> dispatch
        v
Control Kernel Dispatch
   acquireLease() -> 写 execution 行 -> 交给 Harness
        |
        v
Agent Harness（进程边界 + 心跳 + 超时 + 证据落盘）
        |
        v
OpenClaw Agent / Worker（LLM · Tools · Skills · Workspace · Sandbox）
        |  raw stdout / result.json.raw
        v
JSON Harness -> Ajv Schema Validation（contracts/）
        |  (3) 校验通过
        v
Artifact Store：Git worktree + CAS（sha256 内容寻址）
        |  (4) Kernel 写 execution 终态 + artifact 行
        v
StateGraph State Update
        |  (5)
        v
LangGraph Checkpointer -> PostgreSQL schema: langgraph
```

### 写入顺序恒定

```text
Control Kernel 落库（事实）  →  Checkpoint 落库（决策投影）
```

顺序不可颠倒。Kernel 里存在「已完成但 checkpoint 未投影」的执行是**可恢复**的，重启后 `reconcile` 读 Kernel 补投影；反之「checkpoint 说完成但 Kernel 无记录」是**不可恢复**的脏状态。因此所有节点函数把 Kernel 调用放最前、patch 返回放最后。

## 三种状态的职责切分

| 状态类别 | 存放内容 | 存储位置 | 谁能写 |
| --- | --- | --- | --- |
| Workflow State | 路由决策、阶段进度、审批语义、事件链、错误报告 | PG `langgraph.checkpoints` / `checkpoint_writes` | 仅 StateGraph 节点返回的 patch |
| Execution State | `worker_id` / `heartbeat_at` / `lease_expires_at` / `attempt` / `pid` / `exit_code` | PG `kernel.executions` | 仅 Control Kernel（Harness 经 Kernel API 间接写） |
| Artifact State | `artifact_id` / `uri` / `sha256` / `size_bytes` / `media_type` | 内容在 `runtime/artifacts/cas/<sha前2位>/<sha256>`，索引在 `kernel.artifacts` | 仅 JSON Harness 校验通过之后 |

Execution State 必须独立于 checkpoint：Agent 进程真的跑过、真的可能还活着，这些事实不能因为 checkpoint 回滚而消失，否则崩溃恢复时无法判断 worker 是否仍持有 task。

## Control Kernel 职责边界

**负责**：run 生命周期与 `langgraph_thread_id` 绑定；task 台账；execution 事实；artifact 索引；lease 仲裁（同一 task 同时只有一个活跃 execution）；孤儿回收（`reapExpiredLeases()` 扫描过期租约标记 `LEASE_EXPIRED`）；`kernel.events` 哈希链。

**不负责**：路由决策（永远是 StateGraph 的事）、解析 Agent 输出（JSON Harness 的事）、审批判定（`state.pendingApproval` 的事）、托管 prompt（`graph.createTask()` 的事）。

> Kernel 是账本，不是大脑。大脑只有一个，是 StateGraph。

### 关键实现点

- `acquireLease` 是唯一并发闸门：单条 `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`，冲突时查持有者并抛 `LEASE_HELD`。原子、无应用层锁。
- 唯一性索引 `executions_active_lease` 建在 `(task_id)` 而非 `(run_id)`：一个 task 一个活跃 execution，一个 run 可以有多个。串行由 StateGraph 只产生一个 active task 保证，不是靠数据库约束——**串行是并行的退化情形**。
- `appendEvent` 用 `SELECT 1 FROM runs WHERE run_id=$1 FOR UPDATE` 对 run 行加锁，串行化同一 run 的事件写入，防哈希链竞态。
- Kernel 直接 `import { canonicalJson, sha256 } from '../stategraph/events.mjs'`，两条哈希链算法同源，可交叉校验。
- 所有 SQL 使用裸表名，schema 由 `createKernelPool()` 在每条连接的 `connect` 事件上 `SET search_path` 指定（`pool.query()` 每次随机取连接，单次 SET 只对一条连接生效）。

## 标识符与策略

`run_id` 与 `langgraph_thread_id` **分离**：`runs.run_id` 保持 `RUN-` 前缀（`executionIdFor()` / `artifactIdFor()` 依赖 `baseOf(runId,'RUN-')` 去前缀），`langgraph_thread_id` 独立存 `WF-*`。`repository` 输出保持 camelCase（`workflowId`），并提供 `getRunByThreadId(threadId)`。

`config/stategraph-policy.json` 的运维参数在 `loadStateGraphPolicy()` 中校验并生效：

| 字段 | 当前值 | 校验 | 流向 |
| --- | --- | --- | --- |
| `lease_seconds` | 120 | 正整数 | `createKernel({ leaseSeconds })`、`dispatcher.launch({ leaseSeconds })` → `agent-runner --lease-seconds` |
| `heartbeat_interval_seconds` | 30 | 正整数 | `agent-runner --heartbeat-interval-seconds`，决定心跳定时器周期 |
| `parallelism` | `{ enabled:false, max_parallel:1 }` | `enabled` 为 boolean，`max_parallel` ∈ [1,8] | `split_tasks` / `merge_tasks` 直通判定 |

跨字段断言：`lease_seconds > heartbeat_interval_seconds * 2`，否则抛 `POLICY_LEASE_TOO_SHORT`。理由是租约必须能容忍至少两次心跳丢失才判过期，否则正常抖动会误杀活着的 Agent。环境变量 `OPENCLAW_KERNEL_LEASE_SECONDS` 仅作为未注入 policy 时的兜底默认。

## 路线与派发

Manager 只生成 `route-plan.json`，不得填写 Agent ID。`config/stategraph-policy.json` 固定 task kind 到 Agent 的映射，并校验生命周期顺序、request class 门槛、风险门槛、DEVELOPMENT 后必须有 TEST、高风险必须含阶段后人工审批。

`policy.mjs` 的 `ORDER` 常量只用于合法性校验（不倒序、DEVELOPMENT 后必须有 TEST），**实际执行顺序由 `route_plan.steps` 数组决定**。推荐顺序为 `REQUIREMENTS → ARCHITECTURE → DESIGN → DEVELOPMENT → TEST → CODE_REVIEW → RELEASE`，即 **Reviewer 排在 Tester 之后**，让评审能看到测试执行结果与失败证据。该约束写在 `agents/manager-agent/workspace/AGENTS.md`。

每轮始终先生成路线确认节点。批准后 `route_hash`、steps 和 approval plan 冻结；`dispatch` 是唯一 Agent 调用入口，且必须先 `acquireLease()` 成功才调 `dispatcher.start()`。

## 失败与恢复

- `dispatch` 的 `LEASE_HELD` 分支复用 `SANDBOX_GLOBAL_BUSY` 路径：记事件、`stopReason='DISPATCH_DEFERRED'`、不消耗 attempt。串行下不会触发，但接口必须在，否则并行扩展要改核心逻辑。
- `reconcile` 的第五种 kind `LEASE_EXPIRED`：`WAITING` 但 Kernel 显示 execution 已 `LEASE_EXPIRED` 时，走 `failurePatch()`，`error.code='EXECUTION_LEASE_EXPIRED'`，消耗 attempt 重试预算。这是 Kernel 带来的唯一新行为——以前 Agent 进程静默死掉会让 workflow 永久卡在 RUNNING。
- `agent-runner` 周期调 `kernel.lease.heartbeat()`，返回 `null` 即租约已被回收，子进程必须自杀。
- Monitor 的 `reconcileCycle()` 每周期调用 `kernel.lease.reapExpiredLeases()` 回收过期租约；PG 不可达时只标记降级，不中断刷新。
- JSON 重新生成：同 session 最多 2 次，不创建新 task attempt。Agent attempt：初次加 2 次自动重试共 3 次，每次新 run/session/worktree。三次失败生成 `ERROR_ESCALATION`，只能人工选择重试或终止。
- workflow 重启从最新 checkpoint + Kernel 事实恢复，不依赖聊天历史或进程内存。

## Git 候选边界

每次 Agent attempt 使用独立 detached worktree：

```text
runtime/worktrees/<workflow>/<task>/<run>/repo
```

DEVELOPMENT/TEST 的 `output_commit` 必须是完整 commit SHA、基于 `input_commit`、并等于 worktree HEAD。通过 Gate 后才推进 candidate；若该 step 需要人工审批，则批准后才推进。REVIEW 和 RELEASE 只能读取当前 candidate，不能替换它。

`git-worktree.mjs` 的 `pathKey()` 必须保留（Windows `'$GIT_DIR' too big` 规避）。

## 上下文与结果边界

每个 run 由代码生成 `context-manifest.json`，记录身份、input commit、授权路径、规则副本和 SHA-256。dispatch 前与 reconcile 前都会验证普通文件、非 symlink、路径归属和字节级 SHA。

Agent 只写本 run 的 `.agent-raw`、授权 worktree、runner 指定的 raw logs。

本地 ingestion 负责确定性 JSON 清洗、Ajv 校验、身份比对、report/CommandRecord/evidence 路径与 SHA 校验，以及原子发布。校验通过后按内容寻址落 CAS（`storeCasArtifact()`），再由 `evaluate` 节点写 `kernel.artifacts` 索引行。同一份产物被多个 run 引用时天然去重，hash 即完整性校验。

## TEST Docker sandbox

TEST 固定使用 Docker：network none、只读 rootfs、drop ALL、PID 256、2GiB、2 CPU、非 root。每次 session 动态挂载 `/worktree`、`/input`、`/agent-raw`、`/raw-logs`。

动态 bind 配置由全局 lease 串行化。lease 在写配置前持久化；attestation 失败、runner 异常或陈旧 lease 接管时，代码先验证当前 binds，再恢复原配置、重建 session 并释放锁。配置出现第三种未知值时失败关闭。

## Monitor

`monitor/main.mjs` 启动 Node.js 后端，loopback-only、GET-only、无审批/重试/状态写入 API。

**双源合并**：主源 `kernel.projectRuns()` 提供 execution/artifact 事实，副源 `stateRuntime.list()` 提供 workflow 决策语义，合并键为 `run.langgraph_thread_id === state.workflowId`。

**契约冻结**：19 个 HTTP 端点、`publicWorkflow` / `publicTask` / `publicDispatch` 三个 read model 的原有字段名与语义全部不变，只允许追加。本次追加：`publicWorkflow` 的 `run_id` / `langgraph_thread_id`，`publicTask` 的 `execution` / `artifacts` / `task_group_id` / `parallel_slot`，快照与 `/api/health` 的 `kernel_reachable`。`protocol_version: 'stategraph-checkpoint-v1'`、`source: 'LANGGRAPH_CHECKPOINTS'`、`audit().database: 'LANGGRAPH_CHECKPOINTS'` 三个常量值冻结。

**降级**：Kernel 不可达时 `refresh()` 退化为纯 checkpoint 只读投影，`/api/health` 返回 `status:'DEGRADED'` + `kernel_reachable:false`，UI 仍可用，`execution`/`artifacts` 为空。该路径有专门测试覆盖。

**Telemetry 不迁 PG**：`monitor/telemetry-repository.mjs` 的 6 张表继续用 `node:sqlite` 存 `runtime/monitor/monitor.db`。理由是 telemetry 可丢弃（重新 tail session 即可重建）、Monitor 必须能在 PG 挂掉时独立运行、迁移无收益只增加 PG 写压力和失败点。**这是明确的设计决定，不是遗漏。**

## 不引入 Redis

串行单 worker 下 Redis 没有职责：lease 仲裁 PG 行锁能做且更可靠（事务保证），事件分发已有进程内 `MonitorEventHub`。引入 Redis 只增加一个运维组件和一个失败点。多 worker 跨进程时再引入，届时 `MonitorEventHub` 换成 Redis pub/sub，接口不变。

## 并行预留（本次不启用）

接口全部到位并有测试覆盖，开关默认关闭：

- **数据层**：`kernel.tasks.task_group_id` / `parallel_slot` / `depends_on` 字段已在 DDL 中。串行下 `task_group_id = task_id`、`parallel_slot = 0`。
- **图层**：`split_tasks` / `merge_tasks` 两个直通节点已加入图结构。`parallelism.enabled === false` 时纯直通，开启时抛 `PARALLEL_NOT_IMPLEMENTED`。现在就加是因为 LangGraph 的 `addConditionalEdges` 映射表是静态的，将来改图结构会让已存在的 checkpoint 失效。
- **Lease 层**：唯一索引已建在 `task_id`，打开并行开关时数据库层零改动。
- **Worker 池**：`worker_id` 从 `OPENCLAW_WORKER_ID` 读取，多 worker 时表结构与 API 不变。

## 不可动的硬约束

1. StateGraph 是唯一状态机，Kernel 不做路由决策
2. Kernel 保持薄：不解析 Agent 输出、不判审批、不托管 prompt
3. 写入顺序恒定：Kernel 先落库，Checkpoint 后投影
4. 两条哈希链算法同源：Kernel 必须 import `stategraph/events.mjs`，不得重写
5. Monitor 19 端点 + 3 read model 字段冻结，只许追加
6. `audit()` 的 `database: 'LANGGRAPH_CHECKPOINTS'` 字段值冻结
7. `git-worktree.mjs` 的 `pathKey()` 必须保留
8. `monitor/server.mjs` 的 `uiAssets` / `sendAsset` 必须保留
9. `policy.ORDER` 不改，只用于合法性校验
10. 不引入 Redis
11. telemetry 不迁 PG
12. lease 索引建在 `task_id` 而非 `run_id`
13. 双 capability 授权模型（`runtime.capability` / `human-approval.capability`）不改
14. Docker 强制沙箱 attestation 在 TEST 阶段不可绕过
15. workflow 单写锁（原子 `wx` lock + stale 检查）不改
16. detached git worktree 每 run 隔离 + commit ancestry 校验不改

## 语言选型

**Control Kernel 用 JavaScript**，不引 Python。依据：

1. Kernel 调用点全部在 JS 函数体内部，跨语言要引入 IPC/HTTP 层，而 `graph.mjs` 每次 invoke 只走一步，一次 workflow 推进要跨进程多趟。
2. `canonicalJson` 跨语言做字节级一致极易翻车（键序、浮点序列化、Unicode 转义），一旦对不上是**静默的完整性问题**。
3. JS 侧 PG 生态够用：`pg` 纯 JS 无编译负担；`@langchain/langgraph-checkpoint-postgres` 官方包接受外部 Pool。
4. Kernel 是薄的，全是 SQL + 少量哈希，无 ML/数值计算需求。
5. Checkpointer 天然必须留在 JS（LangGraph.js 运行时在 JS 侧），Kernel 去 Python 会切断事务边界。

## 复用与重做边界

| 范围 | 处理 | 原因 |
| --- | --- | --- |
| 七个 Agent 角色与 workspace 目录 | 复用角色，重写永久规则 | 分工仍有效，但旧规则包含多控制面、Manager 派发和无沙箱假设 |
| JSON 清洗、Ajv 校验与原子文件发布 | 复用经过测试的无状态工具 | 这些工具不拥有 workflow 状态，可继续作为本地 ingestion 基础 |
| monitor 的 telemetry、脱敏、SSE 和会话解析 | 复用只读能力 | 展示能力与状态权威正交 |
| 状态持久化 | SQLite → PostgreSQL 双 schema | 消除多套状态库；Kernel 需要事务与行锁做 lease 仲裁 |
| checkpointer | 手写 SQLite saver → 官方 `PostgresSaver` 子类 | 官方包接受外部 Pool，可与 Kernel 共用连接池；只需补 `threadIds()` |
| Agent 执行事实 | 新增 Control Kernel 记录 | 进程存活性不能靠可回滚的 checkpoint 判断 |
| Agent 派发与结果接收 | 固定 dispatch/reconcile + lease 闸门 | 防止 Manager、worker 或 launcher 绕过代码映射和 Gate |
| TEST 执行边界 | Docker policy、attestation 和 lease | 旧本机执行无法证明隔离、mount 和异常恢复 |

## 成本边界

Manager context window 为 `200000`，max output 为 `32000`。软输入预算按 `manager.soft_budget_percent`（当前 `60`）动态计算，即 `context_window_tokens × soft_budget_percent / 100`，当前等于 `120000`，并非硬编码常量。实际单次紧凑 prompt 硬上限为 `12000` 字符。默认只携带最近 8 个事件和 4 个错误摘要；超限后进一步压缩。Manager 不轮询 worker。

## 环境准备

```bash
# .env（不进仓库）
OPENCLAW_PG_URL=postgresql://user:password@localhost:5432/openclaw

npm run kernel:schema   # 幂等应用 kernel schema DDL
npm run kernel:status   # 打印 run/task/execution 计数与过期 lease
npm run test:kernel     # 必须真 PASS，不能是 SKIP
```

`.env.example` 登记全部 `OPENCLAW_PG_*`、`OPENCLAW_KERNEL_*` 与 `OPENCLAW_WORKER_ID`。凭据不进仓库，`.env` 已在 `.gitignore`。

## 相关文档

| 文档 | 用途 |
| --- | --- |
| [`plan/02-target-architecture.md`](./plan/02-target-architecture.md) | 目标分层架构、层↔文件映射、Monitor 契约冻结表 |
| [`plan/03-postgres-data-model.md`](./plan/03-postgres-data-model.md) | PG 数据模型、DDL、lease 实现、事件链 |
| [`plan/06-handoff-status.md`](./plan/06-handoff-status.md) | 进度事实来源与裁决结论 |
| [`adr/`](./adr/) | 关键决策记录 |
| [`monitoring.md`](./monitoring.md) | Monitor 端点、降级与字段说明 |
