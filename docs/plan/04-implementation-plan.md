# 04 · 分阶段实施计划

> 历史计划：本文步骤已失效；当前实施计划见 `docs/superpowers/plans/2026-08-21-sqlite-git-snapshots-hr-review.md`。

> 原则：**每个阶段独立可验证、独立可提交、独立可回滚**。
> 规约：按 `AGENTS.md` 第 6 条，每阶段完成后一次中文 `git commit`；整个重构在 `workbuddy/control-kernel-postgres` 分支上进行。
> 文件级新增/修改/删除总清单与风险表见 [`05-change-manifest.md`](./05-change-manifest.md)。

---

## 0. 阶段总览

| 阶段 | 主题 | 产出 |
| --- | --- | --- |
| **P0** | 基线固化 | 分支 + 清除 webchat-bridge |
| **P1** | PG 基础设施 | `pg` 依赖 + schema + pool + 测试 fixture |
| **P2** | Kernel Repository | 5 表 CRUD + lease + 事件链 |
| **P3** | Postgres Checkpointer | 替换 SQLite checkpointer |
| **P4** | Runtime 接线 | `runtime.mjs` 注入 kernel |
| **P5** | StateGraph 双写 | 节点追加 Kernel 写入 + lease |
| **P6** | Harness 心跳 | dispatcher + agent-runner 心跳 |
| **P7** | Artifact CAS | CAS 落盘 + artifact 索引 |
| **P8** | Monitor 接 Kernel | 双源合并 + 降级 |
| **P9** | 并行接口占位 | split/merge 直通节点 + policy 开关 |
| **P10** | 清理与文档 | 删空目录 + 归档 + 文档同步 |

**顺序约束**：P3 依赖 P1；P5 依赖 P2 + P4；P8 依赖 P5。P9 可与 P8 并行。

---

## P0 · 基线固化

见 [`01-rollback-point-decision.md`](./01-rollback-point-decision.md) §4.2。

| 操作 | 对象 |
| --- | --- |
| 提交 | 26 个已修改文件 + 3 个新增 `.mjs`/`.test.mjs` |
| 删除 | `scripts/stategraph/webchat-bridge.mjs` |
| 检查 | `.gitignore` 覆盖 `.agent-raw/`、`workspace/` |

```bash
npm test
grep -rn "webchat-bridge" scripts tests extensions monitor   # 应无输出
```

提交信息：

```text
基线：固化Manager请求队列与一次性Schema注入的未提交改动
清理：删除已被Manager请求队列取代的WebChat桥接模块
```

---

## P1 · PostgreSQL 基础设施

### 新增

| 文件 | 内容 |
| --- | --- |
| `scripts/control-kernel/schema.sql` | 文档 03 §3 + §4 全部 DDL；schema 名用 `__KERNEL_SCHEMA__` / `__LANGGRAPH_SCHEMA__` 占位符 |
| `scripts/control-kernel/pool.mjs` | `createKernelPool()`、`resolveKernelConfig()`（读 env + 项目根 `.env`） |
| `scripts/control-kernel/apply-schema.mjs` | CLI：读 schema.sql、替换占位符、apply；幂等 |
| `tests/helpers/kernel-fixture.mjs` | 临时 schema 建/拆 + 无 PG 时 skip 判定 |
| `tests/control-kernel-schema.test.mjs` | 建表、重复 apply 幂等、约束生效、DROP 清理 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `package.json` | `dependencies` 加 `"pg": "^8.13.1"`；`scripts` 加 `test:kernel`、`kernel:schema`；`test` 串联加入 `test:kernel` |
| `.env.example`（若无则新建） | 记录 6 个 `OPENCLAW_PG_*` 变量 |

### fixture 的 skip 逻辑（关键）

```js
// tests/helpers/kernel-fixture.mjs
export function kernelUrl() {
  return process.env.OPENCLAW_PG_URL ?? readEnvFile().OPENCLAW_PG_URL ?? null;
}
export function requireKernel(t) {
  const url = kernelUrl();
  if (!url) { t.skip('OPENCLAW_PG_URL not set; kernel tests skipped'); return null; }
  return url;
}
```

**为什么必须有**：没有它，任何未装 PG 的机器上 `npm test` 直接红，重构会卡住。

### 验证

```bash
npm i
npm run kernel:schema
npm run test:kernel
npm test                                   # 无 PG 时也必须全绿（kernel 测试 skip）
psql "$OPENCLAW_PG_URL" -c "\dt kernel.*"
psql "$OPENCLAW_PG_URL" -c "\dt langgraph.*"
```

提交：`基础设施：引入PostgreSQL连接池与Control Kernel数据库结构`

---

## P2 · Kernel Repository 与 API

### 新增

| 文件 | 估算 | 内容 |
| --- | --- | --- |
| `scripts/control-kernel/repository.mjs` | ~320 行 | 5 表纯 SQL CRUD；列名 ↔ JS 字段映射 |
| `scripts/control-kernel/lease.mjs` | ~110 行 | `acquireLease` / `heartbeat` / `releaseLease` / `reapExpiredLeases` / `activeExecution` |
| `scripts/control-kernel/kernel.mjs` | ~180 行 | `createKernel({ pool, clock, workerId })`，组装 repository + lease + 事件链 |
| `scripts/control-kernel/ids.mjs` | ~30 行 | `runIdFor()` / `executionIdFor()` / `artifactIdFor()` |
| `contracts/kernel-run.schema.json` | — | run 投影 schema |
| `contracts/kernel-execution.schema.json` | — | execution 投影 schema |
| `contracts/kernel-artifact.schema.json` | — | artifact 投影 schema |
| `tests/control-kernel-repository.test.mjs` | — | CRUD + 级联删除 + CHECK 约束 |
| `tests/control-kernel-lease.test.mjs` | — | 并发争抢、过期回收、心跳拒绝 |
| `tests/control-kernel-events.test.mjs` | — | 哈希链正确 + 篡改被 audit 检出 |

### 复用现有代码

`scripts/stategraph/events.mjs` 的 `canonicalJson()` / `sha256()` 被 kernel 直接引入，**保证 checkpoint 事件链与 Kernel 事件链算法一致**。该文件本身不改。

### `tests/control-kernel-lease.test.mjs` 必须覆盖

1. **并发争抢**：`Promise.all` 同时对同一 task 发 10 次 `acquireLease` → **恰好 1 次成功、9 次抛 `LEASE_HELD`**
2. **释放后可重领**：`releaseLease` 后再 `acquireLease` 成功
3. **不同 attempt 不互斥**：attempt 1 释放后 attempt 2 能领
4. **过期回收**：`leaseSeconds: 0` → `reapExpiredLeases` 返回该行且 state 变 `LEASE_EXPIRED`
5. **heartbeat 拒绝**：被 reap 后 `heartbeat` 返回 0 行
6. **不同 task 不互斥**：两个 task 各自领 lease 都成功（并行预留的数据层基础）

提交：`内核：实现Control Kernel的Run/Task/Execution/Artifact仓储与租约仲裁`

---

## P3 · PostgreSQL Checkpointer

### 新增

| 文件 | 内容 |
| --- | --- |
| `scripts/stategraph/postgres-checkpointer.mjs` | 基于官方 `PostgresSaver` 的 `KernelPostgresSaver` 包装，补 `threadIds()` 并复用共享 Pool |
| `tests/stategraph-postgres-checkpointer.test.mjs` | 官方四表 setup 幂等、checkpoint/metadata/父链、writes、threadIds、deleteThread 往返测试 |

### 删除

| 文件 | 理由 |
| --- | --- |
| `scripts/stategraph/sqlite-checkpointer.mjs` | 被取代 |
| `scripts/stategraph/database.mjs` | 11 行，`openStateGraphDatabase()` 被 `createKernelPool()` 取代 |

### 可选

`scripts/control-kernel/migrate-from-sqlite.mjs` —— 见文档 03 §8。**只在有必须延续的在跑 workflow 时才写**；否则归档旧 db 直接新建。

### 等价性测试写法

测试直接覆盖官方 saver 的 checkpoint/metadata/pendingWrites 往返；官方 serializer 负责 BYTEA 编解码，避免重复维护与上游不一致的手写实现。

### 验证

```bash
node --test tests/stategraph-postgres-checkpointer.test.mjs
psql "$OPENCLAW_PG_URL" -c "SELECT count(*) FROM langgraph.checkpoints;"
```

提交：`检查点：将LangGraph检查点存储从SQLite迁移到PostgreSQL`

---

## P4 · Runtime 接线

### `scripts/stategraph/runtime.mjs`（111 → ~150 行）

```js
- import { openStateGraphDatabase } from './database.mjs';
- import { SqliteCheckpointSaver } from './sqlite-checkpointer.mjs';
- export function defaultDatabasePath(projectRootInput) { ... }
+ import { createKernelPool, resolveKernelConfig } from '../control-kernel/pool.mjs';
+ import { createKernel } from '../control-kernel/kernel.mjs';
+ import { PostgresCheckpointSaver } from './postgres-checkpointer.mjs';
```

签名扩展（全部可选，保持注入式测试友好）：

```js
export function createStateGraphRuntime({
  projectRoot, pool = null, kernel = null, workerId = null,
  dispatcher = null, worktrees = null, policy = null, clock = () => new Date(),
  skipAuthority = false, runtimeCapability = null, humanCapability = null,
  // databasePath / database 保留但传入即抛错，提示改用 pool
} = {})
```

改造点：

1. `openStateGraphDatabase(...)` → `poolInput ?? createKernelPool(resolveKernelConfig(projectRoot))`
2. `new SqliteCheckpointSaver(connection)` → `new KernelPostgresSaver(pool, { schema: 'langgraph' })`，并等待 `setup()`
3. 新增 `const kernelInstance = kernel ?? createKernel({ pool, clock, workerId: workerId ?? defaultWorkerId() })`
4. `buildWorkflowGraph({ ..., kernel: kernelInstance }, { checkpointer })` —— kernel 作为 dependency 注入 graph
5. `close()` 改 async：`async close() { if (ownPool) await pool.end(); }`
   当前 P4 为保护既有离线测试，显式传入 `databasePath/database` 时仍走 SQLite 兼容路径；P10 删除该过渡入口。
6. **`list()` 主源换 Kernel**：

```js
async function list() {
  const runs = await kernelInstance.listRuns({ limit: 200 });
  const values = [];
  for (const run of runs) {
    const item = await state(run.workflowId);
    if (item) values.push(item);
  }
  return values;
}
```

理由：Kernel 是唯一可信数据源，`listRuns` 走 `runs_state_updated` 索引，比扫全部 checkpoint 分组快，且能带出 `run_id`。

7. **`audit()` 合并两条链**：

```js
async audit(workflowId = null) {
  const values = workflowId ? [await state(workflowId)].filter(Boolean) : await list();
  const workflows = values.map(auditEventChain);          // checkpoint 内事件链
  const kernelChains = [];
  for (const value of values) {
    const run = await kernelInstance.getRunByThreadId(value.workflowId);
    if (run) kernelChains.push(await kernelInstance.auditEvents(run.run_id));
  }
  return {
    ok: workflows.every((i) => i.ok) && kernelChains.every((i) => i.ok),
    database: 'LANGGRAPH_CHECKPOINTS',    // ← 字段值冻结，Monitor 依赖
    workflows,
    kernel: { ok: kernelChains.every((i) => i.ok), runs: kernelChains },
  };
}
```

8. 新增导出：`kernel`、`pool`（供 Monitor 注入使用）

### `scripts/workflow.mjs`

- 移除 `--database` 参数，改 `--pg-url`（或纯 env）
- `close()` 调用加 `await`
- 新增 `kernel-status` 子命令：打印 run/task/execution 计数、过期 lease 数、双写不一致检测

### 验证

```bash
node --test tests/stategraph-runtime.test.mjs
node scripts/workflow.mjs kernel-status
node scripts/workflow.mjs init
node scripts/workflow.mjs bootstrap --workflow WF-SMOKE-001 --text "冒烟" --project "$PWD"
psql "$OPENCLAW_PG_URL" -c "SELECT run_id, langgraph_thread_id, state FROM kernel.runs;"
```

提交：`接线：StateGraph运行时改由Control Kernel与PostgreSQL驱动`

---

## P5 · StateGraph 双写

### `scripts/stategraph/graph.mjs`（583 → ~700 行）

按文档 02 §5.1 的表格，在 8 个节点内追加 Kernel 调用。

**硬约束：Kernel 调用在函数体最前（写事实），patch 返回在最后（写决策）。**

改为 async 的节点：`initialize`、`prepareManager`、`prepareStep`、`reconcile`、`evaluate`、`complete`、`applyHuman`、`integrityHold`、`finish`（`dispatch` 已是 async）。LangGraph 原生支持 async 节点，**图结构零改动**。

#### `initialize`

```js
async initialize(state) {
  if (state.createdAt) return { stopReason: null };
  const occurredAt = now(dependencies);
  // ... 现有全部校验逻辑不动 ...
  const target = dependencies.worktrees.inspectTarget(state.request.project_path_abs);
  let confirmed = null;
  if (state.confirmedRoutePlan) { /* 不动 */ }

  // ★ 先写 Kernel 事实
  const runId = runIdFor(state.workflowId);
  await dependencies.kernel.createRun({
    runId, threadId: state.workflowId, request: state.request,
    requestSha256: dependencies.sha256(state.request),
    targetProjectRoot: target.target_project_root_abs,
    baseCommit: target.head_commit, routeHash: confirmed?.route_hash ?? null,
  });
  await dependencies.kernel.appendEvent({
    runId, type: confirmed ? 'WORKFLOW_CONFIRMED' : 'WORKFLOW_CREATED',
    payload: { route_hash: confirmed?.route_hash ?? null },
  });

  // ★ 再返回决策 patch（追加 runId 通道）
  return appendStateEvent(state, { runId, /* 现有全部字段不动 */ },
    confirmed ? 'WORKFLOW_CONFIRMED' : 'WORKFLOW_CREATED', { /* ... */ }, occurredAt);
}
```

#### `dispatch` 加 lease

```js
async dispatch(state) {
  const task = state.tasks[taskIndex(state)];
  let execution = null;
  try {
    execution = await dependencies.kernel.acquireLease({
      taskId: task.task_id, runId: state.runId, attempt: task.attempt,
      cycle: task.current_cycle ?? 0, agentId: task.agent_id,
      leaseSeconds: dependencies.policy.lease_seconds ?? 120,
    });
  } catch (error) {
    if (error.code === 'LEASE_HELD') {
      return appendStateEvent(state, { stopReason: 'DISPATCH_DEFERRED' },
        'TASK_DISPATCH_DEFERRED',
        { task_id: task.task_id, reason: error.code, details: error.details },
        now(dependencies));
    }
    throw error;
  }
  try {
    const started = await dependencies.dispatcher.start(task, { execution });
    await dependencies.kernel.setTaskState(task.task_id, 'DISPATCHED');
    // 现有 appendStateEvent 不动，payload 追加 execution_id
  } catch (error) {
    await dependencies.kernel.releaseLease(execution.execution_id,
      { state: 'FAILED', error: { code: error.code, message: error.message } });
    // 现有 SANDBOX_GLOBAL_BUSY 分支与 failurePatch 逻辑不动
  }
}
```

#### `reconcile` 加 LEASE_EXPIRED 分支

```js
async reconcile(state) {
  const task = state.tasks[taskIndex(state)];
  await dependencies.kernel.reapExpiredLeases({});
  const result = dependencies.dispatcher.reconcile(task);
  if (result.kind === 'WAITING') {
    const active = await dependencies.kernel.activeExecution(task.task_id);
    if (!active) {                       // lease 已被回收 → Agent 进程死了
      return failurePatch(state, task, {
        code: 'EXECUTION_LEASE_EXPIRED',
        message: 'agent worker heartbeat stopped',
        details: null,
      }, dependencies);
    }
    // ... 现有 WAITING 逻辑不动 ...
  }
  // 其余 kind 不动，只在终态时追加 releaseLease
}
```

这是 Kernel 带来的**唯一新行为**：以前 Agent 进程静默死掉会让 workflow 永久卡在 `RUNNING`，现在被 lease 超时兜住并自动走 attempt 重试预算。

### `scripts/stategraph/state.mjs`（40 → 44 行）

```js
+ runId: replace(),          // Kernel run_id，initialize 时写入
+ taskGroups: replace([]),   // 并行预留，串行下为空数组
+ parallelism: replace(),    // 并行预留，串行下为 null
```

### `config/stategraph-policy.json`

```json
+ "lease_seconds": 120,
+ "heartbeat_interval_seconds": 20,
+ "parallelism": {
+   "enabled": false,
+   "max_concurrent_tasks": 1,
+   "merge_strategy": "SEQUENTIAL_REBASE"
+ }
```

### `scripts/stategraph/policy.mjs`

`loadStateGraphPolicy()` 补 3 个新字段的默认值与校验。**必须断言 `lease_seconds > heartbeat_interval_seconds * 2`**，否则抛 `POLICY_LEASE_TOO_SHORT` —— 不然正常心跳也会被误杀。

### `agents/manager-agent/workspace/AGENTS.md` ⚠️

明确推荐阶段顺序 `DEVELOPMENT → TEST → CODE_REVIEW → RELEASE`（见文档 02 §6），让 Reviewer 能看到测试结果再评审。

> `policy.ORDER` 常量**不改**。它只用于 `assertRouteRules()` 的合法性校验；实际执行顺序由 Manager 产出的 `route_plan.steps` 数组决定。

### 测试

| 文件 | 操作 | 覆盖 |
| --- | --- | --- |
| `tests/stategraph-kernel-integration.test.mjs` | 新增 | run/task/execution 行随节点推进正确产生；lease 冲突走 `DISPATCH_DEFERRED`；lease 过期走 attempt 重试 |
| `tests/stategraph-runtime.test.mjs` | 修改 | 构造 runtime 改传 `pool`/`kernel`；断言 Kernel 行 |
| `tests/stategraph-dispatcher.test.mjs` | 修改 | `start()` 加 `{ execution }` 参数 |
| `tests/stategraph-trust-boundary.test.mjs` | 修改 | Kernel 写入也必须过 capability 校验 |
| `tests/stategraph-sandbox.test.mjs` | 修改 | 沙箱 attestation 落 `executions.sandbox_attestation` |

### 验证

```bash
npm run test:stategraph && npm run test:kernel
node scripts/workflow.mjs bootstrap --workflow WF-E2E-001 --text "..." --project "$PWD"
node scripts/workflow.mjs run --workflow WF-E2E-001
psql "$OPENCLAW_PG_URL" -c "
SELECT t.task_id, t.state AS task_state, e.worker_id, e.state AS exec_state,
       e.heartbeat_at, e.lease_expires_at
FROM kernel.tasks t LEFT JOIN kernel.executions e ON e.task_id = t.task_id
WHERE t.run_id = (SELECT run_id FROM kernel.runs WHERE langgraph_thread_id='WF-E2E-001');"
```

提交：`状态机：StateGraph节点双写Control Kernel事实并接入执行租约`

> ⚠️ **本阶段修改 `agents/manager-agent/workspace/AGENTS.md`，触发 Agent 同步要求。**

---

## P6 · Agent Harness 心跳

### `scripts/stategraph/dispatcher.mjs`（219 → ~260 行）

1. `start(taskInput, { execution } = {})` 接受 execution
2. `launcher.json` 追加：`execution_id` / `worker_id` / `lease_expires_at` / `heartbeat_interval_seconds`
3. `launchDetachedAgent()` 透传 `--execution-id` 与 PG 连接信息给子进程
4. `spawn` 成功后回写 `kernel.updateExecution(executionId, { pid, sessionId, worktreePathAbs, artifactRootAbs })`
5. `reconcile()` **保持同步**（只读文件）；lease 判定放在 graph 层（graph 才持有 kernel 依赖）

### `scripts/stategraph/agent-runner.mjs`（147 → ~200 行）

```js
const heartbeat = setInterval(async () => {
  try {
    const alive = await kernel.heartbeat(executionId, { phase: currentPhase });
    if (!alive) {
      // lease 已被回收 → 立即自杀，防止两个进程写同一 worktree
      process.stderr.write('lease revoked; aborting agent process\n');
      child?.kill('SIGTERM');
      process.exit(75);                        // EX_TEMPFAIL
    }
  } catch { /* PG 抖动容忍，连续失败由 lease 过期兜住 */ }
}, heartbeatIntervalMs);
heartbeat.unref?.();
```

`result.json` 追加 `execution_id` / `worker_id`；写完 `result.json` 后调 `kernel.releaseLease()`。

**注意**：`agent-runner.mjs` 是独立子进程，需自建 pool（`max: 2`），进程退出前 `await pool.end()`。

### 新增测试

`tests/control-kernel-heartbeat.test.mjs` —— 心跳延长 lease；lease 被 reap 后心跳返回 falsy；`releaseLease` 后 `activeExecution` 为空。

### 验证

```bash
npm run test:kernel && npm run test:stategraph
psql "$OPENCLAW_PG_URL" -c "
SELECT execution_id, state, phase, heartbeat_at, lease_expires_at
FROM kernel.executions ORDER BY started_at DESC LIMIT 5;"
```

提交：`执行器：Agent Harness上报心跳并在租约回收时安全退出`

> ⚠️ 修改 dispatcher / agent-runner，属「影响已安装 Agent 行为」范围，**触发 Agent 同步要求**。

---

## P7 · Artifact Store 与 CAS

### 新增

| 文件 | 内容 |
| --- | --- |
| `scripts/control-kernel/cas.mjs` | `putContent(buffer)` → `{ sha256, uri, size_bytes }`，落 `runtime/cas/<前2位>/<sha256>`，已存在则跳过（去重）；`getContent(sha256)`；`verify(sha256)` |
| `tests/control-kernel-cas.test.mjs` | 去重、hash 正确、损坏检出、并发写同内容 |

### `scripts/stategraph/output-ingestion.mjs`（254 行，改动很小）

`ingestTaskOutput()` 返回值追加 `cas: { sha256, uri, size_bytes }` —— 在原子发布之后把已发布内容再 `cas.putContent()` 一次。

**`publishedOutputPath()` 落盘路径不变**（Agent 与人都要能直接看文件），CAS 是额外一份不可变副本 + 索引。

### `scripts/stategraph/graph.mjs` —— `evaluate` 节点

```js
+ await dependencies.kernel.putArtifact({
+   runId: state.runId, taskId: task.task_id, executionId: task.execution_id,
+   kind: artifactKindFor(task.kind), uri: accepted.cas.uri,
+   sha256: accepted.cas.sha256, sizeBytes: accepted.cas.size_bytes,
+   mediaType: 'application/json', commitSha: state.candidateCommit,
+ });
```

### 修改测试

`tests/stategraph-output-boundary.test.mjs` —— 断言 `cas` 字段存在且 hash 与内容一致。

### 验证

```bash
npm run test:kernel && node --test tests/stategraph-output-boundary.test.mjs
psql "$OPENCLAW_PG_URL" -c "SELECT artifact_id, kind, sha256, size_bytes FROM kernel.artifacts ORDER BY created_at DESC LIMIT 10;"
ls runtime/cas | head
```

提交：`产物：接入内容寻址存储并在Control Kernel登记产物索引`

---

## P8 · Monitor 接 Kernel（含降级）

**这是最需要小心的阶段。用户明确要求保留监测功能与 UI 界面。**

### `monitor/config.mjs`（79 → ~90 行）

```js
- databasePath: resolve(... join(runtimeRoot, 'stategraph', 'checkpoints.db')),
+ pgUrl: overrides.pgUrl ?? environment('OPENCLAW_PG_URL') ?? fileConfig.pg_url ?? null,
+ kernelPollIntervalMs: integer(overrides.kernelPollIntervalMs ?? fileConfig.kernel_poll_interval_ms, 2000),
  // monitorDatabasePath 保持不变（telemetry 仍用 SQLite，见文档 02 §8.4）
```

### `monitor/server.mjs`（338 → ~400 行）

1. `createMonitorServer(config, { stateRuntime, kernel, telemetryDatabase, eventHub })` 新增 `kernel` 注入口
2. **`refresh()` 改双源合并 + 降级**：

```js
let kernelReachable = true;
async function refresh() {
  const states = await stateRuntime.list();
  const runs = new Map();
  try {
    for (const run of await kernel.projectRuns({ limit: 200 })) {
      runs.set(run.langgraph_thread_id, run);
    }
    kernelReachable = true;
  } catch (error) {
    kernelReachable = false;                    // ★ 降级：UI 仍可用
    hub.publish('monitor-health', { status: 'DEGRADED', error: error.message },
      { source: 'KERNEL_UNREACHABLE' });
  }
  snapshot = {
    generated_at: new Date().toISOString(),
    source: 'LANGGRAPH_CHECKPOINTS',            // ← 字段值冻结，UI 依赖
    kernel_reachable: kernelReachable,
    workflows: states.map((s) => publicWorkflow(s, telemetry, runs.get(s.workflowId) ?? null)),
  };
}
```

3. `publicWorkflow(state, telemetry, run = null)` —— **22 个原字段一字不改**，末尾追加 `run_id`、`langgraph_thread_id`
4. `publicTask(task, telemetry, run = null)` —— **15 个原字段一字不改**，末尾追加：

```js
+ execution: run?.executions?.[task.task_id] ?? null,
+ artifacts: run?.artifacts?.[task.task_id] ?? [],
+ task_group_id: task.task_group_id ?? task.task_id,
+ parallel_slot: task.parallel_slot ?? 0,
```

5. `/api/health` 追加 `kernel_reachable`；Kernel 不可达时 `status: 'DEGRADED'`
6. `/api/client-config` **一字不改**（`source: 'LANGGRAPH_CHECKPOINTS'` / `mode: 'READ_ONLY'` / `interactive_controls: false`）
7. `reconcileCycle` 定时器追加 `kernel.reapExpiredLeases()` —— Monitor 是常驻进程，天然适合做回收器
8. `close()` 内 `stateRuntime.close()` 加 `await`

### `monitor/main.mjs`

建 pool + kernel 并注入；**PG 连不上时不退出**，打印告警后以降级模式启动。

### `monitor/ui/*` —— 本阶段不改

若要展示 execution 信息，只追加渲染逻辑，不改现有 DOM 与 `/api/*` 调用。**建议先不改 UI**，等后端契约稳定后单独一个提交做增强，避免把「保留 UI」这个硬要求和「增强 UI」混在一起验证。

### 修改测试

| 文件 | 改动 |
| --- | --- |
| `tests/monitor-http.test.mjs` | 断言 19 个端点全部存在；逐字段断言 read model **原有字段名一个不少**；**新增降级用例：kernel 抛错时 `/api/workflows` 仍 200 且 `kernel_reachable:false`** |
| `tests/monitor-static-dashboard.test.mjs` | 断言 5 个静态入口 200 |
| `tests/monitor-sse.test.mjs` | 断言 SSE 首帧仍是 `type:'snapshot'`、`meta.source:'LANGGRAPH_CHECKPOINTS'` |
| `tests/monitor-performance.test.mjs` | 加 Kernel 查询后 `refresh()` 耗时仍在预算内 |

### 验证（逐条手工确认）

```bash
npm run test:monitor
npm run monitor:start &
sleep 3
for p in / /index.html /styles.css /app.js /config.js \
         /api/client-config /api/health /api/workflows /api/supervisor /api/agents; do
  printf '%-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4319$p")"
done
curl -s http://127.0.0.1:4319/api/health

# 降级验证：停掉 PG，UI 必须仍然打得开
docker stop openclaw-pg
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4319/       # 期望 200
curl -s http://127.0.0.1:4319/api/health                              # kernel_reachable:false
docker start openclaw-pg
```

**浏览器人工确认**：打开 `http://127.0.0.1:4319/`，确认工作流列表、任务列表、SSE 实时刷新三项功能与重构前**外观和行为一致**。

提交：`监控：Monitor接入Control Kernel投影并保留检查点降级通道`

---

## P9 · 并行接口占位

### `scripts/stategraph/graph.mjs`

按文档 02 §7.2 新增两个直通节点：

```js
+ splitTasks(state) {
+   if (!dependencies.policy.parallelism?.enabled) return { action: 'dispatch' };
+   throw Object.assign(new Error('parallel task split is not implemented'),
+     { code: 'PARALLEL_NOT_IMPLEMENTED' });
+ },
+ mergeTasks(state) {
+   if (!dependencies.policy.parallelism?.enabled) return { action: 'evaluate' };
+   throw Object.assign(new Error('parallel task merge is not implemented'),
+     { code: 'PARALLEL_NOT_IMPLEMENTED' });
+ },
```

`buildWorkflowGraph()`：

```js
+ .addNode('split_tasks', nodes.splitTasks)
+ .addNode('merge_tasks', nodes.mergeTasks)
  .addConditionalEdges('decide', (state) => state.action, {
    ...,
+   split_tasks: 'split_tasks',
+   merge_tasks: 'merge_tasks',
  })
+ .addEdge('split_tasks', END)
+ .addEdge('merge_tasks', END)
```

`decide()` 追加（**串行下永不命中**，因为 `parallelism.enabled === false` 时 `prepareStep` 不设 `taskGroups`）：

```js
+ if (dependencies.policy.parallelism?.enabled && state.taskGroups?.length
+     && state.taskGroups.some((g) => g.status === 'PENDING_SPLIT')) return { action: 'split_tasks' };
+ if (dependencies.policy.parallelism?.enabled && state.taskGroups?.length
+     && state.taskGroups.every((g) => g.status === 'READY_TO_MERGE')) return { action: 'merge_tasks' };
```

> **为什么现在就加空节点**：LangGraph 的 `addConditionalEdges` 映射表是静态的。现在加进去，将来只改节点函数体，不动图结构 —— 而动图结构会让所有已存在的 checkpoint 失效。

### `contracts/route-plan.schema.json`

step 对象追加可选字段：

```json
+ "split_hint": {
+   "type": "object",
+   "properties": {
+     "max_parallel": { "type": "integer", "minimum": 1, "maximum": 8 },
+     "partition_by": { "enum": ["COMPONENT", "FILE_GROUP", "NONE"] }
+   },
+   "additionalProperties": false
+ }
```

### 新增测试

`tests/stategraph-parallel-interface.test.mjs`：

1. `enabled:false` 时 `splitTasks` 返回 `action:'dispatch'`、`mergeTasks` 返回 `action:'evaluate'`
2. `enabled:true` 时两者抛 `PARALLEL_NOT_IMPLEMENTED`
3. 两个节点已注册进图（`graph.getGraph().nodes` 含 `split_tasks` / `merge_tasks`）
4. **串行 e2e 全程不经过这两个节点**
5. 同 run 两个不同 task 可同时持 lease（数据层已支持并行）

### 验证

```bash
node --test tests/stategraph-parallel-interface.test.mjs
npm run test:stategraph        # 串行行为不得有任何变化
```

提交：`预留：加入并行任务拆分与合并的直通节点与策略开关`

---

## P10 · 清理与文档同步

### 删除（空目录）

| 路径 | 理由 |
| --- | --- |
| `scripts/control-core/` | 空目录，旧三层架构遗留，`docs/architecture.md` 已注明可删 |
| `scripts/monitor-core/` | 空目录，同上 |
| `scripts/orchestrator/` | 空目录（含空的 `workflow-graph/`），同上 |

### 归档（移动，不删）

```bash
mkdir -p runtime/archive
mv runtime/control/control.db*         runtime/archive/    # 旧 Control Kernel SQLite
mv runtime/stategraph/checkpoints.db*  runtime/archive/    # 旧 checkpointer SQLite
```

### 文档更新

| 文件 | 改动 |
| --- | --- |
| `docs/architecture.md` | 重写为 Control Kernel + PostgreSQL 分层架构；更新重建基点说明 |
| `docs/monitoring.md` | 补 `kernel_reachable`、降级行为、`execution`/`artifacts` 新字段 |
| `README.md` | 新增「PostgreSQL 前置准备」；更新环境变量表；**安装/更新/重装命令与 `scripts/install.*` 实际参数保持一致** |
| `SECURITY.md` | 补 PG 凭据管理要求（不进仓库、`.env` 已在 `.gitignore`） |
| `CHANGELOG.md` | 记录本次重构 |
| `docs/adr/` | 新增 4 条 ADR：① 为什么 Kernel 是唯一可信数据源；② 为什么 checkpointer 上 PG 而 telemetry 不上；③ 为什么不引入 Redis；④ 为什么串行是并行的退化情形 |

### `package.json` 最终形态

```json
"scripts": {
  "test": "npm run test:runtime-guard && npm run test:agent-json && npm run test:runtime-bundle && npm run test:kernel && npm run test:stategraph && npm run test:monitor && node --test tests/validate-install.test.mjs",
  "test:kernel": "node --test --test-concurrency=1 tests/control-kernel-*.test.mjs",
  "kernel:schema": "node scripts/control-kernel/apply-schema.mjs",
  "kernel:status": "node scripts/workflow.mjs kernel-status",
  "monitor:start": "node monitor/main.mjs"
},
"dependencies": {
  "@langchain/langgraph": "1.4.9",
  "@langchain/langgraph-checkpoint": "1.1.3",
  "ajv": "^8.17.1",
  "ajv-formats": "^3.0.1",
  "pg": "^8.13.1"
}
```

### 验证

```bash
npm test                                                       # 全绿
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime # dry-run
bash scripts/install.sh --runtime-root runtime                 # dry-run
grep -rn "sqlite-checkpointer\|openStateGraphDatabase\|defaultDatabasePath\|webchat-bridge" scripts monitor tests   # 应无输出
```

提交：`清理：移除旧三层框架空目录并同步Control Kernel架构文档`
