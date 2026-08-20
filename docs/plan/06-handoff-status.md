# 06 · 交接状态报告

> 生成时间：2026-08-17 18:00（2026-08-18 更新：P0–P10 全部完成，§9 三个悬置问题已裁决）
> 分支：`workbuddy/control-kernel-postgres`
> 用途：记录 Control Kernel + PostgreSQL 重构的交接状态

本文件是**唯一的进度事实来源**。开工前必读本文件 §1 §2 §3，再按 §4 逐条执行。

---

## 1. 当前位置速览

| 项 | 值 |
| --- | --- |
| 当前分支 | `workbuddy/control-kernel-postgres` |
| 分支起点 | `49e9143`（`docs: 核对docs与代码实际状态`） |
| 已完成阶段 | P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ · P5 ✅ · P6 ✅ · P7 ✅ · P8 ✅ · P9 ✅ · P10 ✅ |
| 悬置问题 | §9 三条全部已裁决并实施 |
| 下一步 | 计划主体已完成；后续仅需按部署环境维护 PG schema 与 Agent 安装同步 |
| 本地 PG | 已用本机 PostgreSQL 完成真实测试；连接串与口令未写入仓库 |

### 分支提交历史

```
bcf7a35  清理：完成PostgreSQL重构收口并移除SQLite运行时              ← P10
01bc81c  预留：加入并行任务拆分与合并接口                            ← P9
b9a602f  监控：接入Kernel主源并支持降级只读                          ← P8
e8f60aa  产物：加入CAS内容寻址存储与Kernel登记                       ← P7
b3f5326  调度：接入Kernel租约仲裁与Agent心跳                         ← P6
8619f32  状态图：建立Kernel事实先写的双写边界                        ← P5
8794118  运行时：接入PostgreSQLCheckpointer与ControlKernel           ← P4
977fd77  检查点：迁移LangGraph到官方PostgreSQL持久化                 ← P3
8f8b5f2  内核：完成ControlKernelP2收尾并验证PostgreSQL链路           ← P2
611d498  文档：新增Control Kernel重构交接状态报告并更新计划索引
c48be1f  基础设施：引入PostgreSQL连接池与Control Kernel数据库结构     ← P1
6bf1b55  清理：删除已被Manager请求队列取代的WebChat桥接模块           ← P0
7a2e5d5  基线：固化Manager请求队列与一次性Schema注入的未提交改动      ← P0
49e9143  (分支起点，来自 main 线)
```

P0 完全按 `01-rollback-point-decision.md` §4.2 执行：未做 `git reset`，从 `49e9143` 新建分支 → 一次基线提交（36 文件，+3064/-510）→ 一次显式删除提交。`webchat-bridge.mjs` 及其测试已清除。


---

## 2. 已完成的内容（逐文件核实）

### 2.1 P1 · PostgreSQL 基础设施 —— 已提交 `c48be1f`

| 文件 | 行数 | 状态 | 内容 |
| --- | --- | --- | --- |
| `scripts/control-kernel/schema.sql` | 192 | ✅ | 双 schema DDL，占位符 `__KERNEL_SCHEMA__` / `__LANGGRAPH_SCHEMA__` |
| `scripts/control-kernel/pool.mjs` | 93 | ⚠️ 见 §3.1 | `createKernelPool()` + `resolveKernelConfig()` |
| `scripts/control-kernel/apply-schema.mjs` | 47 | ✅ | schema 应用 CLI（`npm run kernel:schema`） |
| `tests/helpers/kernel-fixture.mjs` | 105 | 🟡 未提交改动 | 见 §2.3 |
| `tests/control-kernel-schema.test.mjs` | 239 | ✅ | 11 例：建表/幂等/CHECK/CASCADE/租约索引 |
| `package.json` | — | ✅ | `pg@^8.13.1`；`test:kernel`、`kernel:schema`；已并入 `npm test` 链 |
| `.env.example` | — | ✅ | 登记 6 个 `OPENCLAW_PG_*` + `OPENCLAW_WORKER_ID` |

`schema.sql` 实际建出的对象（已逐行核实，与 `03-postgres-data-model.md` §3 §4 一致）：

- **kernel schema**：`runs` / `tasks` / `executions` / `artifacts` / `events` 五表
- **关键索引**：`executions_active_lease`（partial unique on `task_id` WHERE `state IN ('LEASED','RUNNING')`）——并发闸门的地基，索引建在 `task_id` 而非 `run_id`，为并行预留
- 其余索引：`runs_state_updated`、`tasks_run`、`tasks_state`、`tasks_group`、`executions_task`、`executions_run`、`executions_reap`、`executions_worker`、`artifacts_task`、`artifacts_run`、`artifacts_sha`、`events_run`
- **langgraph schema**：`checkpoints` + `checkpoint_writes` + `checkpoints_latest` 索引
- 全部 `IF NOT EXISTS`，幂等

### 2.2 P2 · Kernel Repository —— 已完成并提交

| 文件 | 行数 | 计划估算 | 状态 |
| --- | --- | --- | --- |
| `scripts/control-kernel/ids.mjs` | 37 | ~30 | ✅ `runIdFor` / `executionIdFor` / `artifactIdFor` |
| `scripts/control-kernel/repository.mjs` | 391 | ~320 | ⚠️ 见 §3.1 §3.3 |
| `scripts/control-kernel/lease.mjs` | 158 | ~110 | ⚠️ 见 §3.1 §3.2 |
| `scripts/control-kernel/kernel.mjs` | 159 | ~180 | ⚠️ 见 §3.1 |
| `contracts/kernel-run.schema.json` | — | — | ⚠️ 见 §3.4（导致测试失败） |
| `contracts/kernel-execution.schema.json` | — | — | ⚠️ 同上 |
| `contracts/kernel-artifact.schema.json` | — | — | ⚠️ 同上 |
| `tests/control-kernel-repository.test.mjs` | 335 | — | ✅ 19 例 |
| `tests/control-kernel-lease.test.mjs` | 188 | — | ✅ 7 例 |
| `tests/control-kernel-events.test.mjs` | — | 计划要求 | ✅ 哈希链、篡改审计、未知 run、并发追加 |

已实现的 API 面（`createKernel({ pool, clock, workerId, leaseSeconds })`）：

```
kernel.ids            = { runIdFor, executionIdFor, artifactIdFor }
kernel.repository     = { upsertRun, getRun, listRuns, setRunState,
                          upsertTask, getTask, listTasks, setTaskState,
                          getExecution, listExecutions,
                          upsertArtifact, listArtifacts }
kernel.lease          = { acquireLease, heartbeat, releaseLease, reapExpiredLeases }
kernel.appendEvent    (BEGIN + SELECT FOR UPDATE on runs 行锁串行化 + 尾哈希 + INSERT + COMMIT)
kernel.auditEvents    (重放全链，重算哈希，输出 { ok, count, broken[] })
kernel.getRun / listRuns / getTask / listTasks / getExecution / listExecutions / listArtifacts
```

**设计上做对的地方**（接手时不要动）：

1. `kernel.mjs:14` 直接 `import { canonicalJson, sha256 } from '../stategraph/events.mjs'` —— 两条哈希链算法同源，这是文档 02 的硬要求。
2. `lease.acquireLease` 用单条 `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`，冲突时再查持有者并抛 `{ code:'LEASE_HELD', details:{ active_execution_id, worker_id } }`。原子、无应用层锁。
3. `lease.heartbeat` 返回 `null` 即"租约已被回收"，语义明确（调用方 Harness 必须自杀）。
4. `repository.mapRunOut` / `mapTaskOut` 同时输出 `state` 与 `status` 两个字段 —— 因为 Monitor 的 `publicTask.status` 字段名已冻结，这是刻意的双出口。
5. `appendEvent` 用 `SELECT 1 FROM runs WHERE run_id=$1 FOR UPDATE` 对 run 行加锁，串行化同一 run 的事件写入 —— 防哈希链竞态。

`tests/control-kernel-lease.test.mjs` 已覆盖计划 P2 要求的 6 条中的 5 条：

| 计划要求 | 状态 |
| --- | --- |
| 1. 并发争抢 10 路恰好 1 成功 | ✅ |
| 2. 释放后可重领 | ✅ |
| 3. 不同 attempt 不互斥 | 🟡 隐含在 #2，未独立断言 |
| 4. 过期回收 → `LEASE_EXPIRED` | ✅ |
| 5. heartbeat 被 reap 后返回 null | ✅ |
| 6. **不同 task 不互斥** | ❌ **缺失** —— 这是并行预留的数据层基础，必须补 |

### 2.3 未提交的工作区改动

```
 M tests/helpers/kernel-fixture.mjs         ← createTestPool 增加 searchPath 选项
?? contracts/kernel-artifact.schema.json
?? contracts/kernel-execution.schema.json
?? contracts/kernel-run.schema.json
?? scripts/control-kernel/ids.mjs
?? scripts/control-kernel/kernel.mjs
?? scripts/control-kernel/lease.mjs
?? scripts/control-kernel/repository.mjs
?? tests/control-kernel-lease.test.mjs
?? tests/control-kernel-repository.test.mjs
```

`kernel-fixture.mjs` 的改动很重要，接手时要理解它揭示的问题：

```js
export function createTestPool(url, { max = 4, searchPath = null } = {}) {
  const pool = new Pool({ ... });
  // 必须用 'connect' 事件而非 pool.query(SET ...)，因为连接池复用连接且
  // pool.query() 每次随机取一条连接，单次 SET 只对一条连接生效。
  if (searchPath) {
    pool.on('connect', (client) => { client.query(`SET search_path TO "${searchPath}"`); });
  }
  return pool;
}
```

这条注释说的坑是对的。**但生产侧的 `createKernelPool()` 没有做同样的事** —— 见 §3.1。

---

## 3. 本轮已修复的缺陷

### 3.1 🔴 生产连接池缺 `search_path`，SQL 会找不到表 —— 已修复

**症状**：`repository.mjs` 与 `lease.mjs` 的所有 SQL 使用**裸表名**（`FROM runs`、`INSERT INTO executions`），依赖连接上的 `search_path`。但 `scripts/control-kernel/pool.mjs:76-83` 的 `createKernelPool()` **完全没有设置 `search_path`**，`.env.example` 的连接串也没带 `?options=`。

生产环境下 `search_path` 默认是 `"$user", public`，而表建在 `kernel` schema → 所有 repository/lease 调用报 `relation "runs" does not exist`。

测试之所以绿，是因为测试专门传了 `searchPath`，而且**PG 未配置时整套 skip**，等于这条路径从未执行过。

**修法（推荐 A）**：在 `createKernelPool()` 里按连接设置，与 fixture 同构。

```js
export function createKernelPool({ url, max = 8, statementTimeoutMs = 15000,
  connectTimeoutMs = 5000, kernelSchema = 'kernel' } = {}) {
  if (!url) { throw Object.assign(new Error('OPENCLAW_PG_URL is required'), { code: 'KERNEL_PG_URL_MISSING' }); }
  const pool = new Pool({ /* 原样 */ });
  pool.on('connect', (client) => {
    client.query(`SET search_path TO "${kernelSchema}", public`);
  });
  return pool;
}
```

同时 `resolveKernelConfig()` 增加 `kernelSchema: env('OPENCLAW_KERNEL_SCHEMA') ?? 'kernel'`，`.env.example` 登记该项。

**必须连带修**：`kernel.mjs` 的 4 处 SQL 硬编码了 `kernel.` 前缀（第 40、48、70、98 行：`FROM kernel.runs`、`FROM kernel.events`、`INSERT INTO kernel.events`）。这与 repository/lease 的裸表名风格不一致，且在测试临时 schema 下必然失败（临时 schema 叫 `kernel_t_<hex>`，不叫 `kernel`）。**统一改成裸表名**，全部靠 `search_path`。

**验证必须新建一个不 skip 的实测**：配置本地 PG 后跑一次真实的 `createKernelPool()` + `upsertRun` + `appendEvent` 往返，不能只依赖传了 `searchPath` 的测试池。

### 3.2 🟠 缺失 `lease.activeExecution()` —— 已补齐

计划 P2 明确列出 5 个 lease 方法，`activeExecution` 未实现。`graph.mjs` 的 `reconcile` 节点判 `LEASE_EXPIRED` 需要它（P5 依赖）。

```js
async activeExecution(taskId) {
  const { rows } = await pool.query(
    `SELECT ${EXEC_RETURN} FROM executions
      WHERE task_id = $1 AND state IN ('LEASED','RUNNING')
      ORDER BY started_at ASC LIMIT 1`, [taskId]);
  return rows.length === 0 ? null : mapExecution(rows[0]);
}
```

顺带：`acquireLease` 冲突分支里已有一段等价查询，可抽出来复用。

### 3.3 🟠 `repository` 缺 `getRunByThreadId()`，且 P4 计划里的字段名与实现不符 —— 已修复

`04-implementation-plan.md` §P4 的代码片段用了两个当前不存在/不一致的东西：

```js
const item = await state(run.langgraph_thread_id);        // ← mapRunOut 输出的是 run.workflowId
const run = await kernelInstance.getRunByThreadId(...);   // ← 该方法不存在
```

`mapRunOut()`（`repository.mjs:28-47`）返回的是 camelCase 的 `workflowId`，不是 `langgraph_thread_id`。

**两个选择，二选一并统一**：

- **选择 A（推荐）**：保持 repository 输出 camelCase，补 `getRunByThreadId(threadId)` 方法，并**改文档 04 §P4 的代码片段**为 `run.workflowId`。
- 选择 B：改 `mapRunOut` 输出 snake_case —— 不推荐，会污染 Monitor 侧字段冻结契约。

由于 `run_id` 与 `langgraph_thread_id` 在 `ids.mjs:20-25` 的设计里是 1:1（`runIdFor()` 直接返回 threadId 原值），`getRunByThreadId` 可以简单实现为按 `langgraph_thread_id` 列查询，但要注意 schema 里 `run_id` 有 `^RUN-` 的 CHECK 约束（见 `contracts/kernel-run.schema.json`），而 StateGraph 现有 threadId 形如 `WF-WEB-<hex>` / `WF-SMOKE-001`。**这两者的前缀约定目前是冲突的，P4 接线前必须裁决**：

- 要么 `runs.run_id` 放弃 `RUN-` 前缀约束，直接用 threadId
- 要么 `run_id` 独立生成（`RUN-<hex>`），`langgraph_thread_id` 单独存 `WF-*`，此时 `ids.runIdFor()` 的"直接返回原值"实现必须改

推荐后者（两个 ID 分离），因为 `executionIdFor()` / `artifactIdFor()` 都用 `baseOf(runId, 'RUN-')` 去前缀，依赖 `RUN-` 存在。

### 3.4 🟡 新增 contracts 打破了契约枚举测试 —— 已修复

`npm test` 当前有 1 个**由本次改动直接引起**的失败：

```
not ok 2 - 轻量 Agent 契约测试为每个 JSON Schema 定义对应 Agent 与格式
  - 'kernel-artifact.schema.json'
  - 'kernel-execution.schema.json'
  - 'kernel-run.schema.json'
```

`tests/agent-llm-json-harness.test.mjs:34` 断言 `contracts/` 目录下所有非内部 schema 都必须在 `CONTRACT_SCENARIOS` 里有对应 Agent。三个 kernel schema 不是 Agent 产出物，属于**内部投影契约**。

**修法**：在 `scripts/agent-llm-contract-tests/contract-scenarios.mjs:25` 的 `INTERNAL_CONTRACTS` 集合里加三行：

```js
export const INTERNAL_CONTRACTS = new Set([
  'agent-activity.schema.json',
  'agent-checkpoint.schema.json',
  'monitor-event.schema.json',
  'kernel-run.schema.json',
  'kernel-execution.schema.json',
  'kernel-artifact.schema.json',
]);
```

### 3.5 ⬜ 缺失 `tests/control-kernel-events.test.mjs` —— 已补齐

计划 P2 要求"哈希链正确 + 篡改被 audit 检出"。必须覆盖：

1. 连续 append 3 个事件 → `prev_hash` 正确串联，首个为 `null`
2. `auditEvents` 返回 `ok: true`
3. 直接 `UPDATE events SET payload=...` 篡改 → audit 检出 `hash_mismatch`
4. 直接 `UPDATE events SET prev_hash=...` → audit 检出 `chain_break`
5. `appendEvent` 对不存在的 run → 抛 `RUN_NOT_FOUND`
6. 并发 append（`Promise.all` 10 路同 run）→ 链依然完整无分叉（验证 `FOR UPDATE` 行锁有效）

第 6 条是关键，`FOR UPDATE` 串行化是否真的生效只能靠并发测试证明。

---

## 4. 后续待完成阶段

### 4.0 P2 收尾（本轮已完成）

按顺序：

1. 修 §3.1（`search_path` + `kernel.mjs` 去前缀）
2. 修 §3.4（`INTERNAL_CONTRACTS`）→ `npm test` 该项转绿
3. 补 §3.2（`activeExecution`）
4. 裁决并修 §3.3（`run_id` vs `threadId` 前缀策略 + `getRunByThreadId`），同步改 `docs/plan/04-implementation-plan.md` §P4 代码片段
5. 补 §3.5（events 测试）+ lease 的"不同 task 不互斥"用例
6. **配置本地 PG 并真实跑一遍**（见 §5），确认 kernel 三套件不是 SKIP 而是真 PASS
7. `git add` 全部 P2 文件 + 提交

提交信息：

```text
内核：实现Control Kernel的Run/Task/Execution/Artifact仓储与租约仲裁
```

### 4.1 P3 · PostgreSQL Checkpointer

⚠️ **计划需要修订**。`03-postgres-data-model.md` §7 与 `04-implementation-plan.md` §P3 目前写的是"手写 `PostgresCheckpointSaver`（149 行改造）"。上一轮已确认存在官方包：

```js
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";  // v1.0.4
const checkpointer = new PostgresSaver(pool, undefined, { schema: "langgraph" });
await checkpointer.setup();   // 首次必须调用
```

它接受外部 `pg.Pool`，可与 Kernel 共用连接池 —— 这正是"Kernel 先写、Checkpoint 后投影"所需的。

**接手时必须先做的决策**（三选一，并把结论写回文档 03 §7）：

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| A. 直接用官方包 + 子类补 `threadIds()` | 少写 ~150 行，跟随上游修 bug | 表结构与 `schema.sql` 的 `langgraph` schema **不一致**（官方多一张 blobs 表），`schema.sql` 该段要删掉改由 `setup()` 建 |
| B. 手写（原计划） | 表结构完全可控，与 `schema.sql` 一致 | 自己维护 serde/迁移 |
| C. 官方包 + 保留 `schema.sql` 的 langgraph 段作对照 | — | 两套表结构并存，**不要选** |

**倾向 A**。若选 A，需连带处理：

- `schema.sql` 删除 `__LANGGRAPH_SCHEMA__` 段（166-190 行），`apply-schema.mjs` 与 `kernel-fixture.schemaSqlWith()` 的双占位符替换逻辑要跟着简化
- `threadIds()` 是**本项目自定义方法**，官方 `PostgresSaver` 没有。`runtime.list()` 与 Monitor 都依赖它。必须子类化：

```js
class KernelPostgresSaver extends PostgresSaver {
  async threadIds() {
    const { rows } = await this.pool.query('SELECT DISTINCT thread_id FROM checkpoints');
    return rows.map((r) => r.thread_id);
  }
}
```

- `threadIds()` 从同步变 async 的连带影响：上一轮已量化为**只需改 2 行**（`runtime.list()` / `monitor.refresh()` 早已是 async）

无论选哪个方案，删除项不变：

- `scripts/stategraph/sqlite-checkpointer.mjs`（149 行）
- `scripts/stategraph/database.mjs`（11 行）

### 4.2 P4 · Runtime 接线

改 `scripts/stategraph/runtime.mjs`（111 → ~150 行）。详见 `04-implementation-plan.md` §P4，但注意 §3.3 指出的字段名错误。

要点：`databasePath` / `database` 参数保留但传入即抛错；`close()` 改 async；`list()` 主源换 Kernel；`audit()` 合并两条链但 `database: 'LANGGRAPH_CHECKPOINTS'` 字段值**冻结不可改**（Monitor 依赖）。

`scripts/workflow.mjs` 新增 `kernel-status` 子命令。

### 4.3 P5 · StateGraph 双写 ⚠️ 触发 Agent 同步

`graph.mjs`（583 → ~700 行）。13 节点全保留、路由结构不变，节点内追加 Kernel 写入。`dispatch` 加 lease 争抢失败分支；`reconcile` 新增第五种 kind `LEASE_EXPIRED`。

**此阶段改 `agents/manager-agent/workspace/AGENTS.md`（Reviewer 顺序调整），交付时必须提醒用户更新已安装 Agent。**

⚠️ **该顺序调整（Reviewer 放在 Tester 之后）用户尚未确认，P5 开工前必须先问。**

### 4.4 P6 · Harness 心跳 ⚠️ 触发 Agent 同步

`dispatcher.mjs`（219 → ~260）+ `agent-runner.mjs`（147 → ~200）。子进程周期调 `kernel.lease.heartbeat()`，返回 `null` 即自杀。

### 4.5 P7 · Artifact CAS

CAS 落盘 + `artifacts` 表索引登记。`output-ingestion.mjs` 改动很小；`graph.evaluate` 节点登记产物。

### 4.6 P8 · Monitor 接 Kernel（含降级）

`monitor/config.mjs`（79 → ~90）+ `monitor/server.mjs`（338 → ~400）。

**硬约束**（来自 `02-target-architecture.md` §8）：19 个 HTTP 端点全部保留、3 个 read model 共 45 个字段名冻结（只允许追加）、`protocol_version: 'stategraph-checkpoint-v1'` 与 `source: 'LANGGRAPH_CHECKPOINTS'` 常量值不变、PG 不可达时必须降级到纯 checkpoint 源并有专门测试、**本阶段不改 `monitor/ui/*`**、telemetry 仍用独立 SQLite 不迁 PG。

### 4.7 P9 · 并行接口占位

`graph.mjs` 加 `splitTasks` / `mergeTasks` 两个直通节点（policy 关闭时直接透传，开启时抛 `PARALLEL_NOT_IMPLEMENTED`）。`contracts/route-plan.schema.json` 加并行字段。

### 4.8 P10 · 清理与文档同步

删空目录（`scripts/control-core/`、`scripts/monitor-core/`、`scripts/orchestrator/` 已确认为空）、归档 `runtime/control/` 旧遗留、同步 README。

---

## 5. 环境准备（下一个 Agent 必做）

**当前 `.env` 不存在，所有 kernel 测试都是 SKIP —— PG 侧代码一行都没真正执行过。** 这是最大的风险来源，§3.1 的缺陷就是这么漏掉的。

```bash
# 1. 起一个本地 PG
docker run -d --name openclaw-pg \
  -e POSTGRES_USER=openclaw -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=openclaw -p 5432:5432 postgres:16

# 2. 建 .env（从 .env.example 复制，至少设置这一行）
#    OPENCLAW_PG_URL=postgresql://openclaw:password@localhost:5432/openclaw

# 3. 应用 schema
npm run kernel:schema

# 4. 确认表建出来了
psql "$OPENCLAW_PG_URL" -c "\dt kernel.*"
psql "$OPENCLAW_PG_URL" -c "\di kernel.*"

# 5. kernel 测试必须是真 PASS，不能是 SKIP
npm run test:kernel
```

第 5 步的判据：输出里出现 `# pass 37` 之类的正数，而不是 `# SKIP OPENCLAW_PG_URL not set`。

---

## 6. 测试基线（接手前的已知状态）

`npm test` 串联 7 项。**当前基线：3 类失败**，接手时必须能区分"我改坏的"和"本来就坏的"。

| 套件 | 结果 | 判定 |
| --- | --- | --- |
| `test:runtime-guard` | 5/5 pass | ✅ |
| `test:agent-json` | 11/12，1 fail | 🔴 **本次改动引起**，修法见 §3.4 |
| `test:runtime-bundle` | 3/3 pass | ✅ |
| `test:stategraph` | 24~29/31，**2~7 fail 不稳定** | ⚠️ 见下 |
| `test:monitor` | 14/14 pass | ✅ |
| `test:kernel` | 3 suites **全 SKIP** | ⚠️ 无 PG，见 §5 |
| `validate-install` | 5/6，1 fail | ⬜ 已知 GBK mojibake 问题，与本次改造无关，不要动 |

### `test:stategraph` 的不稳定失败 —— 环境问题，非代码问题

两次运行结果不同（2 fail vs 7 fail），全部是 Windows 文件锁：

```
EPERM: operation not permitted, rename
  '...\runtime\artifacts\WF-json-retry\...\.task.json.<pid>.<uuid>.tmp'
  -> '...\runtime\artifacts\WF-json-retry\...\task.json'
  at replaceFileAtomic (scripts/runtime-core/atomic-store.mjs:81)

EBUSY: resource busy or locked, unlink
  'C:\Users\...\Temp\stategraph-runtime-XXXX\checkpoints.db'
```

成因：机器上有 4 个残留 `node.exe` 进程持有 `runtime/artifacts/` 与临时 checkpoint db 的句柄（很可能是之前的 Monitor 或 workflow 进程未退出）。

**接手时先清干净再跑测试**，否则会误判：

```bash
# Windows：确认并清理残留进程
tasklist | grep -i node
# 逐个确认不是当前需要的进程后再终止

# 清理测试产物残留
rm -rf runtime/artifacts/WF-json-retry runtime/artifacts/WF-launch-failure
```

清理后 `test:stategraph` 应回到 31/31 或仅剩个别与本改造无关的失败。**不要因为这些 EPERM/EBUSY 去改 `atomic-store.mjs`** —— 那是正常的原子写实现，问题在环境。

---

## 7. 不可动的硬约束（重申，来自文档 02 §10）

接手时如果发现某处"看起来可以简化"，先对照这张表：

1. **StateGraph 是唯一状态机** —— Kernel 不做路由决策
2. **Kernel 保持薄** —— 不解析 Agent 输出、不判审批、不托管 prompt
3. **写入顺序恒定** —— Kernel 先落库（事实）→ Checkpoint 后投影（决策）
4. **两条哈希链算法同源** —— Kernel 必须 import `stategraph/events.mjs` 的 `canonicalJson`/`sha256`，不得重写
5. **Monitor 19 端点 + 45 个字段名冻结**，只许追加
6. **`audit()` 的 `database: 'LANGGRAPH_CHECKPOINTS'` 字段值冻结**
7. **`git-worktree.mjs` 的 `pathKey()` 必须保留**（Windows `'$GIT_DIR' too big` 规避）
8. **`monitor/server.mjs` 的 `uiAssets` / `sendAsset` 必须保留**（UI 托管）
9. **`policy.ORDER` 不改** —— 只用于合法性校验，实际顺序由 `route_plan.steps` 决定
10. **不引入 Redis**（串行单 worker 下无职责）
11. **telemetry 不迁 PG**（可丢弃观测数据 + Monitor 必须能独立运行）
12. **lease 索引建在 `task_id` 而非 `run_id`**（并行预留）
13. **双 capability 授权模型**（`runtime.capability` / `human-approval.capability`）不改
14. **Docker 强制沙箱 attestation** 在 TEST 阶段不可绕过
15. **workflow 单写锁**（原子 `wx` lock + stale 检查）不改
16. **detached git worktree 每 run 隔离 + commit ancestry 校验**不改

---

## 8. 语言选型（已裁决）

**Control Kernel 用 JavaScript**，不引 Python。依据：

1. Kernel 调用点全部在 JS 函数体内部（`graph.dispatch` 抢 lease、`reconcile` 读 execution、`dispatcher` 写事实、`agent-runner` 心跳、Monitor 投影），跨语言就要引入 IPC/HTTP 层，而 `graph.mjs` 每次 invoke 只走一步，一次 workflow 推进要跨进程多趟
2. `canonicalJson` 跨语言做字节级一致极易翻车（键序、浮点序列化、Unicode 转义），一旦对不上是**静默的完整性问题**
3. JS 侧 PG 生态已够用：`pg` 纯 JS 无编译负担；`@langchain/langgraph-checkpoint-postgres` 官方包存在且接受外部 Pool
4. Kernel 是薄的，全是 SQL + 少量哈希，无 ML/数值计算需求
5. Checkpointer 天然必须留在 JS（LangGraph.js 运行时在 JS 侧），Kernel 去 Python 会切断事务边界，"Kernel 先写 → Checkpoint 后投影"就无法用单事务保证

---

## 9. 悬置问题裁决结论（已裁决）

三个问题均已由用户裁决并落地实施，后续接手的 Agent 直接按结论执行，不需要再问：

| # | 问题 | 结论 | 落地位置 |
| --- | --- | --- | --- |
| 1 | Reviewer 放在 Tester 之后的顺序调整是否认可？ | **认可并已实施**。推荐阶段顺序固定为 `REQUIREMENTS → ARCHITECTURE → DESIGN → DEVELOPMENT → TEST → CODE_REVIEW → RELEASE`，`CODE_REVIEW` 必须排在 `TEST` 之后，让 Reviewer 能看到测试结果与失败证据再评审。`policy.mjs` 的 `ORDER` 常量不改，仅用于合法性校验。 | `agents/manager-agent/workspace/AGENTS.md` §首次对话与流程确认 第 5 条 |
| 2 | P3 的 checkpointer 方案选 A（官方包）还是 B（手写）？ | **采纳方案 A**：使用 `@langchain/langgraph-checkpoint-postgres` 官方包，子类补 `threadIds()`；`schema.sql` 删除 `__LANGGRAPH_SCHEMA__` 段，langgraph 表结构改由 `setup()` 建。手写 `sqlite-checkpointer.mjs` / `database.mjs` 已删除。 | `scripts/stategraph/postgres-checkpointer.mjs`、`scripts/control-kernel/schema.sql` |
| 3 | `run_id` 与 `langgraph_thread_id` 是否分离为两个 ID？ | **已分离**。`runs.run_id` 保持 `RUN-` 前缀（`executionIdFor()` / `artifactIdFor()` 依赖 `baseOf(runId,'RUN-')`），`langgraph_thread_id` 独立存 `WF-*`；`repository` 输出保持 camelCase 并补 `getRunByThreadId(threadId)`。 | `scripts/control-kernel/ids.mjs`、`scripts/control-kernel/repository.mjs` |

裁决后的连带修正：`docs/plan/04-implementation-plan.md` §P4 代码片段的 `run.langgraph_thread_id` 已按结论 3 统一为 `run.workflowId`；`docs/plan/03-postgres-data-model.md` §7 已按结论 2 改写。

---

## 10. 相关文档索引

| 文档 | 用途 |
| --- | --- |
| [`README.md`](./README.md) | 计划文档集索引 |
| [`01-rollback-point-decision.md`](./01-rollback-point-decision.md) | git 回滚点决策（P0 已按此执行完毕） |
| [`02-target-architecture.md`](./02-target-architecture.md) | 目标分层架构、层↔文件映射、Monitor 契约冻结表、16 条不可变约束 |
| [`03-postgres-data-model.md`](./03-postgres-data-model.md) | PG 数据模型、DDL、lease 实现、事件链、**§7 需按 §4.1 修订** |
| [`04-implementation-plan.md`](./04-implementation-plan.md) | P0–P10 分阶段计划、**§P4 代码片段需按 §3.3 修正** |
| [`05-change-manifest.md`](./05-change-manifest.md) | 文件级变更清单、风险表、Agent 同步阶段 |
| **`06-handoff-status.md`** | **本文件 —— 进度事实来源** |

---

## 11. Agent 同步提醒

本次改动（P0–P2）**未触及** `agents/*/workspace/`、`agents/common/`、`agents/packages/builtin/*.json`，也未改 Agent 模型/sandbox/tools/delegation 或安装脚本逻辑。

**因此目前无需重装或更新已安装 Agent。**

进入 **P5** 与 **P6** 时会触及 `agents/manager-agent/workspace/AGENTS.md` 与 Agent 心跳行为，届时必须在交付中提醒用户执行：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

（普通更新即可，无需停 Gateway；仅在注册状态或受管理 runtime 损坏时才建议 `reinstall-agents.ps1`。）
