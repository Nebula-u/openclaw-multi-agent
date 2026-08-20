# 07 · LangGraph 原生化 + 自研 Monitor GUI 入口 改造方案

> 本文件是**可直接执行的施工说明书**，面向任意接手的 AI 或工程师。
> 阅读者无需先读其它文档即可开工，但每个阶段动工前必须按「开工前必读」列出的文件实际打开确认，
> 因为本文记录的行号基于 `workbuddy/langgraph-native-gui-plan` 分支创建时刻的代码状态。
>
> - 编制日期：2026-08-19
> - 基线分支：`workbuddy/control-kernel-postgres`
> - 施工分支：`workbuddy/langgraph-native-gui-plan`
> - 适用仓库：`openclaw-multi-agent`

---

## 0. 先纠正一个常见误解

**本项目的「stategraph」不是自研状态机，它已经是官方 LangGraph。**

`package.json:23-25` 已声明：

```json
"@langchain/langgraph": "1.4.9",
"@langchain/langgraph-checkpoint": "1.1.3",
"@langchain/langgraph-checkpoint-postgres": "1.0.4"
```

`scripts/stategraph/graph.mjs:4` 直接 `import { END, START, StateGraph } from '@langchain/langgraph'`，
`scripts/stategraph/state.mjs:1` 使用官方 `Annotation`，
`scripts/stategraph/postgres-checkpointer.mjs:4` 继承官方 `PostgresSaver`。

所以本方案**不是「换引擎」**，而是四件独立的事：

| 编号 | 工作项 | 本质 | 风险 |
|---|---|---|---|
| **P1** | 用满 LangGraph 高级能力（并行 / 子图 / time-travel / interrupt） | 补齐未实现的占位功能 | 中（状态通道 reducer 必须先改造） |
| **P2** | 脱离 OpenClaw CLI，节点内原生执行 Agent | 重做 Agent 执行层 | 高（工程量最大） |
| **P3** | 自研 Monitor 从只读面板升级为可操作 GUI 入口 | 只读服务加写通道 | 中（安全边界变化） |
| **P4** | Monitor 内置对话式 Agent 入口（网页版 Agent） | 加对话层 + 意图二段提交 | 中（LLM 授权边界是关键） |

**四者互相独立，可分别验收、分别回滚。推荐顺序：P3 → P4 → P1 → P2。**

顺序理由：

- **P3 先做**：P1/P2/P4 改完后都需要一个能点按钮的界面来验证，先把界面做出来后续调试效率最高。
- **P4 紧随 P3**：P4 只依赖 P3 的 HTTP 骨架，**不依赖 P2**（见 P4 章「与 P2 的关系」）。
  做完 P3+P4 就已经得到一个可用的网页版 Agent，用户价值最早兑现。
- **P1 第三**：并行化是内部优化，有了 GUI 才好观察扇出效果。
- **P2 最后**：工程量最大、风险最高，且 P4 已经把 LLM 接入抽象成 provider 接口，
  P2 完成后只需替换 provider 实现，不动上层。

---

## 1. 现状事实清单（施工必须依据的锚点）

### 1.1 图结构

`scripts/stategraph/graph.mjs:711-757` 装配了 **15 个节点**：

```
START → initialize → decide → ┬→ prepare_manager    → END
                              ├→ prepare_step       → END
                              ├→ split_tasks        → END
                              ├→ merge_tasks        → END
                              ├→ dispatch           → END
                              ├→ reconcile          → END
                              ├→ compile_plan       → END
                              ├→ evaluate           → END
                              ├→ apply_human        → END
                              ├→ apply_route_change → END
                              ├→ complete           → END
                              ├→ integrity_hold     → END
                              └→ finish             → END
```

**关键特征：每次 `graph.invoke()` 只走一跳业务节点就到 END。**
多轮推进靠外部反复调用 `runtime.run(workflowId)`。
`decide` 自身不路由，它把决策写进 `state.action`，由 `addConditionalEdges('decide', (state) => state.action, {...})`（`graph.mjs:729-743`）分发。

`compile()` 只传了一个参数（`graph.mjs:757`）：

```js
.compile({ checkpointer });
```

没有 `interruptBefore` / `interruptAfter` / `store`。

### 1.2 状态通道（P1 的头号障碍）

`scripts/stategraph/state.mjs:3-6` **全文件只有一种 reducer**：

```js
const replace = (defaultValue = null) => Annotation({
  reducer: (_current, next) => next,
  default: () => structuredClone(defaultValue),
});
```

32 个通道全部是 last-write-wins 覆盖语义。
`tasks`、`events`、`managerReports` 等「追加型」数据都是在节点内手工 `[...state.tasks, task]` 拼出来再整体覆盖。

> **这是并行化的硬阻塞点。** LangGraph 在同一 superstep 内若有多个节点写同一个通道，
> 而该通道 reducer 不支持合并，会抛 `InvalidUpdateError`。P1 必须先改 reducer。

`taskGroups`（`state.mjs:32`）和 `parallelism`（`state.mjs:33`）是并行预留字段，当前恒为空/false，
且**节点读的是 `dependencies.policy.parallelism` 而不是 `state.parallelism`**（见 `graph.mjs:389`、`graph.mjs:435`）。

### 1.3 事件哈希链（P1 的第二个障碍）

`scripts/stategraph/events.mjs:23-43` 的 `appendStateEvent`：

```js
const revision = Number(state.revision ?? 0) + 1;
const previous = state.events?.at(-1)?.event_hash ?? null;
```

事件链是**严格串行**的：revision 自增 + previous_event_hash 前后咬合，
`auditEventChain`（`events.mjs:45-61`）会校验 `EVENT_REVISION_GAP` / `EVENT_PREVIOUS_HASH_MISMATCH`。

并行分支同时调用 `appendStateEvent` 会读到相同的 `previous`，导致链断裂、审计失败。

同样的哈希算法被 Control Kernel 复用（`scripts/control-kernel/kernel.mjs:13` 从 `../stategraph/events.mjs` 导入 `canonicalJson`/`sha256`），两条链要能交叉校验。

### 1.4 并行占位实现

`scripts/stategraph/graph.mjs:434-442`：

```js
splitTasks(state) {
  if (!dependencies.policy.parallelism?.enabled) return { action: 'dispatch' };
  throw Object.assign(new Error('parallel task split is not implemented'), { code: 'PARALLEL_NOT_IMPLEMENTED' });
},

mergeTasks(state) {
  if (!dependencies.policy.parallelism?.enabled) return { action: 'evaluate' };
  throw Object.assign(new Error('parallel task merge is not implemented'), { code: 'PARALLEL_NOT_IMPLEMENTED' });
},
```

对应测试 `tests/stategraph-parallel-interface.test.mjs`（3 个用例，现在断言的正是「抛 PARALLEL_NOT_IMPLEMENTED」）。

配置开关在 `config/stategraph-policy.json:10`：

```json
"parallelism": { "enabled": false, "max_parallel": 1 }
```

校验逻辑在 `scripts/stategraph/policy.mjs:62-71`（`max_parallel` 上限 8）。

**Control Kernel 侧的并行字段已经就位**（无需改数据库）：
`scripts/control-kernel/repository.mjs:150,170-171,194-195` 已有 `task_group_id` / `parallel_slot` / `depends_on` 列，
`graph.mjs:132-133` 已在写入这两个字段（当前恒为 `task_id` 和 `0`）。

### 1.5 Kernel 双写

`graph.mjs:700-710` 的 `wrapped` 包装器给每个节点套了一层：

```js
const wrapped = (name, node) => async (state) => {
  const result = await node(state);
  const workflowId = state.workflowId ?? result?.workflowId;
  const cursor = eventCursors.get(workflowId) ?? 0;
  const nextCursor = await syncKernelFacts(dependencies.kernel, state, result ?? {}, dependencies, cursor);
  if (workflowId) eventCursors.set(workflowId, nextCursor);
  return result;
};
```

`syncKernelFacts`（`graph.mjs:96-192`）先把事实写进 PostgreSQL `kernel` schema，再由 LangGraph 写 `langgraph` schema 的 checkpoint。

> `eventCursors` 是 `buildWorkflowGraph` 闭包内的 `Map`，进程重启后从 0 重放。
> 并行分支下这个 Map 会产生竞态，P1 需要处理。

### 1.6 Runtime 对外接口

`scripts/stategraph/runtime.mjs:113-172` 返回：

| 方法 | 行 | 说明 |
|---|---|---|
| `bootstrap({workflowId, request})` | 122 | 新建（走 manager 分析） |
| `bootstrapConfirmed({workflowId, request, routePlan})` | 126 | 新建（已带确认路线） |
| `run(workflowId)` | 130 | 推进一跳 |
| `approve(workflowId, command)` | 134 | 人工审批，authority = `'human'` |
| `revise(workflowId, command)` | 138 | 变更路线 |
| `state(workflowId)` | 144 | 读单个（**注意叫 state 不叫 getState**） |
| `list()` | 145 | 列全部 |
| `audit(workflowId?)` | 146 | 事件链审计 |
| `managerContext(workflowId)` | 163 | 紧凑上下文 |
| `close()` | 169 | 关连接池 |

还暴露了 `graph`（`runtime.mjs:120`）、`checkpointer`（`:119`）、`kernel`（`:117`）、`policy`（`:121`）。

`config` 工厂（`runtime.mjs:76`）：

```js
const config = (workflowId) => ({ configurable: { thread_id: workflowId, checkpoint_ns: '' }, recursionLimit: 20 });
```

所有 invoke 都套 `withWorkflowLock`（`runtime.mjs:107`），文件锁在 `runtime/stategraph/locks/`。

**离线模式切换条件**（`runtime.mjs:44`）：`const offlineMemory = Boolean(databasePath);`
只要传非空 `databasePath` 就用 `RuntimeMemorySaver`（内存），此时 `pool = null`、`kernel = null`。测试大量依赖这条路径。

### 1.7 能力令牌（写操作的安全闸门）

`scripts/stategraph/authority.mjs`：

- `initializeAuthority(projectRoot)`（`:21`）生成两个 32 字节 hex 令牌文件，mode 0600：
  - `runtime/stategraph/runtime.capability`
  - `runtime/stategraph/human-approval.capability`
- `assertAuthority(projectRoot, kind, supplied)`（`:32`）用 `timingSafeEqual` 比对，
  未传 `supplied` 时回落到环境变量 `OPENCLAW_STATEGRAPH_CAPABILITY` / `OPENCLAW_HUMAN_APPROVAL_CAPABILITY`。
- `agentEnvironment()`（`:41`）在 spawn 子进程前剥离这三个令牌环境变量。

**P3 加写通道时必须复用这套机制，不得另造一套鉴权。**

### 1.8 Agent 执行链路（P2 的改造对象）

三级 spawn：

```
graph.mjs dispatch 节点
  → dependencies.dispatcher.start(task)                    [dispatcher.mjs:83]
    → launchDetachedAgent(...)                             [dispatcher.mjs:46-70]
      → spawn(process.execPath, ['agent-runner.mjs', ...]) [detached, stdio ignore]
        → spawn('openclaw', ['agent','--agent',id,...])    [agent-runner.mjs:39-41,122]
```

OpenClaw CLI 调用参数（`agent-runner.mjs:39-41`）：

```js
const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message-file', messagePath,
  '--thinking', 'off', '--verbose', 'off', '--timeout', String(timeout), '--json'];
```

可执行文件解析在 `scripts/stategraph/process-utils.mjs:11-19`，
环境变量 `OPENCLAW_COMMAND` 可覆盖，Windows 下走 `cmd.exe /d /s /c`。

Agent 落盘契约（`dispatcher.mjs:18-30`）：

```
<artifact_root>/.stategraph-dispatch/attempt-<n>/cycle-<m>/
  ├── message.md      # 输入提示词
  ├── launcher.json   # 启动清单（存在即视为已启动，幂等）
  ├── status.json     # 心跳/状态
  ├── result.json     # Agent 结构化输出
  ├── stdout.log
  └── stderr.log
<artifact_root>/logs/agent-process.jsonl   # 原始流水
```

Agent 身份映射唯一决策点在 `graph.mjs:315`：

```js
agent_id: dependencies.policy.task_agents[kind],
```

映射表在 `config/stategraph-policy.json:19-28`：

| kind | agent_id |
|---|---|
| MANAGER_ANALYSIS | manager-agent |
| REQUIREMENTS | requirement-agent |
| ARCHITECTURE | architect-agent |
| DESIGN | architect-agent |
| DEVELOPMENT | developer-agent |
| CODE_REVIEW | review-agent |
| TEST | test-agent |
| RELEASE | release-agent |

`dispatcher.mjs:78` 会二次校验这个映射（`DISPATCH_AGENT_POLICY_MISMATCH`）。

Agent 人设资产在 `agents/<id>/workspace/`（`AGENTS.md` / `IDENTITY.md` / `SOUL.md` / `TOOLS.md` / `rules/`），
声明式包描述在 `agents/packages/builtin/<id>.json`。
**`graph.mjs` 本身不 import 任何 `agents/` 下的文件**——这些是 OpenClaw 加载的 workspace 素材。

Git 隔离由 `scripts/stategraph/git-worktree.mjs` 负责，每个 run 一个 detached worktree（`git-worktree.mjs:82-96`）。

### 1.9 Monitor 现状

- 入口 `monitor/main.mjs`，`npm run monitor:start`，默认 `127.0.0.1:4319`（`monitor/config.mjs:63-64`）。
- **纯只读**：`monitor/server.mjs:259-371` 的路由表里**一个 POST 都没有**，
  且 `originHeaders`（`server.mjs:51`）只声明 `'access-control-allow-methods': 'GET,OPTIONS'`。
- 强制回环：`server.mjs:262` `if (!isLoopback(...)) return 403 LOOPBACK_ONLY`。
- CSP 写在 **HTML meta** 里（`monitor/ui/index.html:7`）：
  ```
  default-src 'self'; connect-src 'self' http://127.0.0.1:*; script-src 'self'; style-src 'self';
  img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'
  ```
- 客户端能力声明写死为只读（`server.mjs:269-278`）：
  ```js
  interactive_controls: false,
  mode: 'READ_ONLY',
  ```
- 配置里两个开关**硬编码为 false**（`monitor/config.mjs:76,78`）：
  ```js
  workflowContinuationEnabled: false,
  interactiveControlsEnabled: false,
  ```
- **`monitor/workflow-continuation.mjs` 已经写好但从未被任何代码引用**
  （全仓 grep 只有 `config.mjs` 的开关和 3 个测试的配置字段提到它）。
  它的 `scan()` 会对所有 ACTIVE workflow 循环调 `runtime.run()` 直到遇到等待点，最多 `maxTurns` 轮。
  **这是 P3 的现成积木。**
- SSE 事件总线 `monitor/event-hub.mjs`：`publish(type, payload, meta)` / `subscribe(fn)` / `after(seq)` / `sequence`。
- 前端 `monitor/ui/app.js` 是单文件 IIFE（87 行），
  用 `EventSource` 订阅 `/api/workflows/stream`（`app.js:72`），只渲染列表 + 对话流 + 上下文卡片，**没有任何按钮**（除主题切换）。

### 1.10 现有测试

```
tests/stategraph-dispatcher.test.mjs
tests/stategraph-kernel-integration.test.mjs
tests/stategraph-manager-queue.test.mjs
tests/stategraph-output-boundary.test.mjs
tests/stategraph-parallel-interface.test.mjs     ← P1 会改写
tests/stategraph-policy.test.mjs
tests/stategraph-postgres-checkpointer.test.mjs
tests/stategraph-runtime.test.mjs
tests/stategraph-runtime-postgres.test.mjs
tests/stategraph-sandbox.test.mjs
tests/stategraph-trust-boundary.test.mjs
tests/stategraph-webchat-plugin.test.mjs
tests/monitor-artifact-watcher.test.mjs
tests/monitor-health.test.mjs
tests/monitor-http.test.mjs                       ← P3 会扩充
tests/monitor-performance.test.mjs
tests/monitor-redactor.test.mjs
tests/monitor-session-catalog.test.mjs
tests/monitor-session-tailer.test.mjs
tests/monitor-sse.test.mjs
tests/monitor-static-dashboard.test.mjs
```

跑测试：

```bash
npm test                  # 全量
npm run test:stategraph   # node --test tests/stategraph-*.test.mjs
npm run test:monitor      # node --test --test-concurrency=1 tests/monitor-*.test.mjs
npm run test:kernel
```

### 1.11 已安装 LangGraph 1.4.9 可用的高级 API（已实测确认）

```
StateGraph, Annotation, Command, Send, interrupt, task, entrypoint,
MemorySaver, InMemoryStore, BaseStore, messagesStateReducer,
GraphInterrupt, isInterrupted, getCurrentTaskInput, getStore, getWriter,
CompiledStateGraph, START, END
```

**`Send` / `Command` / `interrupt` 全部可用，不需要升级依赖。**

---

## 2. 施工总则（每个阶段都要遵守）

1. **分支与提交**：本方案的实施在 `workbuddy/langgraph-native-gui-plan` 或其子分支上进行。
   每完成一个「任务」（下文带 `T-x.y` 编号者）必须 `git commit` 一次，commit message 用中文简述本次改动。
   格式参考：`workbuddy: 为 tasks 通道引入按 task_id 合并的 reducer`。
2. **不许猜行号**：动工前用 `Read` 打开目标文件确认当前内容，本文行号仅作导航。
3. **测试先行/同步**：任何行为变更都要有对应测试；改了既有断言要在 commit message 里说明原因。
4. **不要破坏离线模式**：大量测试依赖 `createStateGraphRuntime({ databasePath })` 的内存路径，改造不得要求必须连 PostgreSQL。
5. **Agent 同步提醒**：若改动触及 `agents/<id>/workspace/`、`agents/common/`、`agents/packages/builtin/*.json`、
   Agent 模型/sandbox/tools/delegation、安装复制模板或 runtime bundle 逻辑，
   **最终交付必须提醒用户更新已安装 Agent**，并给出命令：
   ```text
   Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
   Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
   ```
   P2 一定会触发这条规则；P1/P3 通常不会。
6. **每阶段结束跑一次 `npm test`**，全绿才算完成。

---

## P3 · 自研 Monitor 升级为可操作 GUI 入口

> 先做 P3。它不动状态机，风险最低，且做完后 P1/P2 的调试可以直接在网页上点。

### 目标

把 `monitor/` 从「只读 SSE 仪表盘」升级为「本机 GUI 控制台」，支持：

- 新建 workflow（提交需求文本 + 目标仓库路径）
- 一键推进（run / 连续推进）
- 人工审批（APPROVE / REVISE / REWORK / RETRY_SAME_AGENT / ABORT）
- 查看事件链审计结果
- 保留原有实时只读能力

**明确不做**：不引入 LangSmith、不引入 LangGraph Studio、不引入任何前端构建工具链（保持零依赖静态资源）。

### 安全基线（不可妥协）

| 约束 | 现状 | P3 后 |
|---|---|---|
| 仅回环访问 | `server.mjs:262` 已强制 | **保持不变** |
| Origin 白名单 | `server.mjs:264` 已有 | **保持不变**，写请求额外要求 Origin 必须等于自身 origin |
| 写操作鉴权 | 无写操作 | **必须**携带 `authority.mjs` 的能力令牌 |
| 审批操作鉴权 | — | 必须用 `human-approval.capability`，其它写操作用 `runtime.capability` |
| CSRF | — | 写请求要求自定义头 `x-stategraph-capability`（浏览器跨站无法自动附加），且拒绝 `content-type: text/plain` 之外的简单请求绕过 |
| 令牌暴露面 | — | 令牌**只在 Node 侧读文件**，绝不下发给浏览器；浏览器调 `/api/*` 时由 monitor 进程代持 |

> **关键设计决策**：不要把 capability 令牌塞进前端 JS。
> Monitor 进程本身运行在用户主机、以用户身份读取 0600 的令牌文件，
> 浏览器 → monitor 这一段靠「回环 + Origin 校验 + 自定义头」防护，
> monitor → runtime 这一段用真实令牌。这样令牌不出进程。

### 任务清单

#### T-3.1 让 monitor 能持有能力令牌

**文件**：`monitor/config.mjs`

- 新增配置项（沿用现有 `overrides ?? env ?? fileConfig ?? default` 三级回落写法）：
  - `interactiveControlsEnabled`：把第 78 行的硬编码 `false` 改为
    `boolean(overrides.interactiveControlsEnabled ?? environment('MONITOR_INTERACTIVE') ?? fileConfig.interactive_controls, false)`
    —— **默认仍为 false**，必须显式开启。
  - `workflowContinuationEnabled`：同上，改为可配置，默认 `false`。
  - `controlTokenHeader`：默认 `'x-stategraph-control'`（前端固定发这个头，值随便，只用于 CSRF 防护）。

**文件**：`monitor/server.mjs`

- 在 `createMonitorServer` 内部，当 `config.interactiveControlsEnabled === true` 时，
  从 `authorityPaths(config.projectRoot)`（`scripts/stategraph/authority.mjs:5`）读取两个令牌文件内容缓存到闭包变量。
  文件不存在时**不要 crash**，而是把 `interactiveControlsEnabled` 降级为 `false` 并 `hub.publish('monitor-health', {...})` 告警，
  提示用户先跑 `node scripts/workflow.mjs init --project-root .`。
- 构造 `stateRuntime` 时把令牌透传下去（`runtime.mjs:41-42` 已支持 `runtimeCapability` / `humanCapability` 入参）：
  ```js
  const stateRuntime = providedRuntime ?? createStateGraphRuntime({
    projectRoot: config.projectRoot,
    databasePath: config.databasePath,
    runtimeCapability,   // 新增
    humanCapability,     // 新增
  });
  ```

**测试**：在 `tests/monitor-http.test.mjs` 增加「未初始化 capability 时 interactiveControls 自动降级为只读」用例。

**提交**：`workbuddy: monitor 支持读取 stategraph 能力令牌并可配置交互开关`

---

#### T-3.2 加请求体读取与写请求防护中间件

**文件**：`monitor/server.mjs`

- 新增 `readJsonBody(request, limit)` 辅助函数：按 `config.requestBodyLimit`（`config.mjs:68`，默认 1MB）截断，
  超限返回 `413 REQUEST_BODY_TOO_LARGE`，JSON 解析失败返回 `400 REQUEST_BODY_INVALID`。
- 新增 `assertWritable(request, config)` 守卫，任何 POST 路由第一行调用，依次校验：
  1. `config.interactiveControlsEnabled` 为 true，否则 `403 INTERACTIVE_CONTROLS_DISABLED`
  2. `request.headers.origin` 严格等于 `http://${config.host}:${config.port}`，否则 `403 ORIGIN_NOT_ALLOWED`
     （注意：这里比 GET 的 `isAllowedOrigin` 更严，不接受 `null` origin）
  3. `request.headers[config.controlTokenHeader]` 存在，否则 `403 CONTROL_HEADER_REQUIRED`
- 修改 `originHeaders`（`server.mjs:51`）把 allow-methods 改为 `'GET,POST,OPTIONS'`，
  并补 `'access-control-allow-headers': 'content-type,' + config.controlTokenHeader`。

**测试**：`tests/monitor-http.test.mjs` 补：缺头拒绝、错 Origin 拒绝、开关关闭时拒绝、超大 body 拒绝。

**提交**：`workbuddy: monitor 增加写请求防护中间件与请求体读取`

---

#### T-3.3 落地写 API

**文件**：`monitor/server.mjs`，在现有 GET 路由之后追加。

| 方法 | 路径 | 入参 | 调用 | 令牌 |
|---|---|---|---|---|
| POST | `/api/workflows` | `{ workflow_id, request: { text, project_path_abs } }` | `stateRuntime.bootstrap(...)` | runtime |
| POST | `/api/workflows/:id/run` | `{}` | `stateRuntime.run(id)` | runtime |
| POST | `/api/workflows/:id/advance` | `{ max_turns? }` | 连续推进（见 T-3.4） | runtime |
| POST | `/api/workflows/:id/approve` | `{ decision_id, choice, decided_by, notes? }` | `stateRuntime.approve(id, cmd)` | **human** |
| POST | `/api/workflows/:id/revise` | `{ request_id, route_plan, requested_by, user_request }` | `stateRuntime.revise(id, cmd)` | runtime |
| GET | `/api/workflows/:id/audit` | — | `stateRuntime.audit(id)` | 只读，无需令牌 |

实现要点：

- `workflow_id` 必须校验 `^WF-[A-Za-z0-9][A-Za-z0-9-]*$`（与 `graph.mjs:345` 一致），不合法返回 `400 WORKFLOW_ID_INVALID`。
- `decided_by` 必须匹配 `^human:[A-Za-z0-9._-]+$`（与 `graph.mjs:599` 一致），
  否则状态机会进 HOLD，不如在 API 层就拒掉，返回 `400 APPROVAL_ACTOR_INVALID`。
- 每个写操作成功后立刻 `await refresh()` 并 `hub.publish('command-result', {...}, { source: 'MONITOR_CONTROL' })`，
  让所有 SSE 客户端立刻看到结果。
- runtime 抛出的错误带 `code` 字段（如 `WORKFLOW_ALREADY_EXISTS` / `WORKFLOW_NOT_FOUND` / `WORKFLOW_ROUTE_CHANGE_BUSY` /
  `STATEGRAPH_CAPABILITY_INVALID`），沿用现有 catch 块（`server.mjs:368-370`）的错误信封即可，
  但要把 `WORKFLOW_NOT_FOUND` 映射成 404、`WORKFLOW_ALREADY_EXISTS` 映射成 409。
- 更新 `/api/client-config`（`server.mjs:269-278`）返回真实能力：
  ```js
  interactive_controls: config.interactiveControlsEnabled,
  mode: config.interactiveControlsEnabled ? 'INTERACTIVE' : 'READ_ONLY',
  control_header: config.controlTokenHeader,
  continuation_enabled: config.workflowContinuationEnabled,
  ```

**测试**：新建 `tests/monitor-control-api.test.mjs`，用 `databasePath` 离线 runtime 跑完整
「bootstrap → run → 到达 WAITING_HUMAN → approve → 继续」链路。

**提交**：`workbuddy: monitor 落地 workflow 控制类写接口`

---

#### T-3.4 接上已有的 workflow-continuation

**文件**：`monitor/server.mjs`

`monitor/workflow-continuation.mjs` 已经写好（33 行），只需接线：

```js
import { createWorkflowContinuation } from './workflow-continuation.mjs';
// ...
const continuation = createWorkflowContinuation({
  runtime: stateRuntime,
  publish,
  enabled: config.workflowContinuationEnabled,
  maxTurns: config.workflowContinuationMaxTurns,   // config.mjs:77 已有，默认 8
});
```

- `POST /api/workflows/:id/advance` 走它的逻辑（可能需要给 `createWorkflowContinuation` 加一个
  只推进单个 workflow 的 `advanceOne(workflowId)` 导出，保持 `scan()` 不变）。
- 若 `config.workflowContinuationEnabled` 为 true，在 `reconcileCycle()`（`server.mjs:231`）里追加
  `await continuation.scan()`，实现「后台自动推进」。**默认关闭**，因为它会真的启动 Agent 进程。
- 新增 `GET /api/continuation` 返回 `continuation.status()`。

> **注意 `workflow-continuation.mjs:17` 直接调 `runtime.run()`，会触发真实 Agent spawn。**
> 打开这个开关前必须确认 OpenClaw（P2 之前）或原生 runner（P2 之后）可用。

**测试**：`tests/monitor-continuation.test.mjs`，用打桩 runtime 验证 maxTurns 与停止条件。

**提交**：`workbuddy: 接线 workflow-continuation 并开放推进接口`

---

#### T-3.5 前端加操作 UI

**文件**：`monitor/ui/index.html`、`monitor/ui/app.js`、`monitor/ui/styles.css`

- `index.html:7` 的 CSP **保持 `script-src 'self'`，不要加 `unsafe-inline`**。
  新增的按钮事件必须在 `app.js` 里用 `addEventListener` 绑定（现有代码已是这个风格，见 `app.js:32`）。
- 新增 DOM：
  1. 侧栏顶部「+ 新建流程」按钮 → 展开一个内联表单（需求文本 textarea + 目标仓库路径 input + 提交按钮）。
     `workflow_id` 由前端生成 `WF-` + 时间戳，或让用户填。
  2. 右侧上下文面板底部「操作」卡片：
     - `condition === 'ACTIVE'` 时显示「推进一步」「连续推进」按钮
     - `pending_approval` 非空时，按 `pending_approval.options[]`（结构见 `policy.mjs:181-185`）
       动态渲染选项按钮 + 一个「审批人」输入框（默认填 `human:` 前缀）+ 备注 textarea
  3. 顶栏加「审计」按钮 → 调 `/api/workflows/:id/audit` 弹出结果
- 所有写请求经过统一封装：
  ```js
  const command = async (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [state.controlHeader]: '1' },
    body: JSON.stringify(body),
  });
  ```
  `state.controlHeader` 从 `/api/client-config` 的 `control_header` 字段读取。
- `reload()`（`app.js:76`）里根据 `client.interactive_controls` 决定是否渲染操作区，
  false 时保持现有只读文案（`index.html:39` 那段「只读监测」卡片）。
- 现有的 `renderKey` 去重机制（`app.js:26-28`、`:57-59`）要把 `pending_approval` 纳入（`workflowRenderState` 第 18 行已包含），
  但要确认按钮的事件监听在每次 innerHTML 重写后重新绑定，避免失效。

**测试**：`tests/monitor-static-dashboard.test.mjs` 已在校验静态资源，扩充断言：
CSP 未放宽、`app.js` 不含内联 `onclick`、新增的 DOM id 存在。

**提交**：`workbuddy: monitor 前端增加新建、推进与审批操作界面`

---

#### T-3.6 文档与启动脚本同步

- `README.md`：新增「Monitor 交互模式」章节，说明
  `MONITOR_INTERACTIVE=true npm run monitor:start`，
  并强调必须先 `node scripts/workflow.mjs init --project-root .` 生成能力令牌。
- `docs/monitoring.md`：更新只读描述，补写 API 表与安全模型。
- `config/monitoring.example.json`：补 `interactive_controls` / `workflow_continuation_enabled` 示例项。
- `scripts/start-monitor.ps1`（18 行，已存在）：在 `param(...)` 块补 `[switch]$Interactive`，
  在设置 `$env:MONITOR_PORT` 之后加一行 `if ($Interactive) { $env:MONITOR_INTERACTIVE = 'true' }`。
  注意该脚本第 16 行用的是反斜杠路径 `'monitor\main.mjs'`，不要顺手改成正斜杠，保持原样。
- `scripts/start-monitor.sh`（11 行，已存在）：在 `export MONITOR_PORT=...` 之后加
  `export MONITOR_INTERACTIVE="${MONITOR_INTERACTIVE:-false}"`，
  并在文件头部支持 `--interactive` 参数把它置为 `true`。
  该脚本用 `set -euo pipefail` 且最后是 `exec node`，改动要保持 `exec` 在最后一行。

**提交**：`workbuddy: 同步 monitor 交互模式文档与示例配置`

### P3 验收标准

- [ ] `npm test` 全绿
- [ ] `MONITOR_INTERACTIVE=true npm run monitor:start` 后，浏览器打开 `http://127.0.0.1:4319/` 可以：
      新建 workflow → 看到 manager 分析任务被创建 → 到达路线确认 → 在网页点「确认并冻结」→ 流程继续
- [ ] 关闭 `MONITOR_INTERACTIVE` 时界面回到纯只读，POST 全部 403
- [ ] 未 `workflow.mjs init` 时 monitor 启动不崩溃，只是降级只读并给出提示
- [ ] 用 `curl` 从非回环地址访问被 403（如条件允许）
- [ ] 不带 `x-stategraph-control` 头的 POST 被 403

---

## P4 · Monitor 内置对话式 Agent 入口（网页版 Agent）

> **目标**：在 monitor 网页里直接跟 Agent 对话下命令，对话与审批同处一个界面，
> 不再依赖 OpenClaw 的 webchat 插件。
>
> **前置**：P3 全部完成（需要 HTTP 写通道、令牌持有、CSRF 防护、SSE 已就绪）。
> **不依赖 P2**（理由见下方「与 P2 的关系」）。

### P4.1 为什么需要 P4

P3 做完后 GUI 只能做**结构化控制**：新建、推进、在预设选项里审批。
用户无法表达「TTL 改成 5 分钟，另外加个缓存击穿保护」这类具体意见——
点「按人工意见重新分析」（`policy.mjs:183` 的 `REVISE` 选项）只能传递「人类不满意」这一个比特，
`graph.mjs:606` 虽然会把 `command.notes` 写进 `request.human_revision_note`，
但 P3 的审批表单里那个 notes 输入框是自由文本，Manager 拿到后并无对话上下文可参考。

而项目里**已经存在**一条自然语言通路，只是不在 monitor 上：

```
用户 → OpenClaw webchat → manager-agent
     → extensions/stategraph-webchat/index.js（拦截 inbound）
     → runtime/agents/manager-agent/workspace/.stategraph/requests/*.json
     → manager-request-queue.mjs:125 扫描
     → runtime.bootstrapConfirmed / revise / approve
```

P2 会移除 OpenClaw，**这条通路届时会消失**。P4 就是把它迁进 monitor 并做成正经的网页版 Agent。

### P4.2 不可妥协的安全前提（先读这一节，否则会做错）

`manager-request-queue.mjs:16` 有一行决定性的校验：

```js
if (value.submitted_by !== 'manager-agent' || value.user_authorized?.confirmed !== true
    || !/^human:[A-Za-z0-9._-]+$/u.test(value.user_authorized?.actor ?? '')) {
  throw Object.assign(new Error('only a user-authorized Manager request may change StateGraph'),
    { code: 'MANAGER_REQUEST_AUTH_INVALID' });
}
```

**这条约束的含义是：LLM 永远不能自己给自己授权。**
`contracts/manager-request.schema.json:27` 把 `confirmed` 定义成 `{ "const": true }`，
`:28` 把 `actor` 限制成 `^human:` 前缀——这是整个系统人机权责边界的根。

因此 P4 **必须**采用二段提交，**禁止**让 LLM 的输出直接落到 `runtime.*` 写方法上：

```
第一段（LLM 可做）：自由文本 → 结构化意图草案 intent_draft
                    此时 user_authorized 字段不存在，无法通过校验

第二段（只有人能做）：UI 渲染意图卡片 → 用户点「确认执行」
                    → 服务端补 user_authorized: { confirmed: true, actor: 'human:xxx' }
                    → 才调用 runtime.bootstrapConfirmed / revise / approve
```

**如果接手者图省事把这两段合并成一段，等于把系统的人工审批机制作废。这是本方案唯一的红线。**

### P4.3 会话数据放哪（不要放进 LangGraph state）

**结论：对话记录存独立存储，不进 `WorkflowState`。**

理由：

1. `state.mjs:37` 的 `events` 通道是审计链（SHA-256 前后咬合，见 1.3 节），
   聊天消息不是状态转移，混进去会污染审计语义。
2. 每条消息都写 checkpoint 会让 `revision`（`state.mjs:19`）疯狂自增，
   而 Control Kernel 双写（1.5 节）以 revision 为序，会被聊天噪声淹没。
3. 对话可能很长，`manager-context.mjs:30` 的 `prompt_max_chars` 裁剪逻辑
   已经在跟上下文长度搏斗，再塞进 state 会雪上加霜。

**新建** `monitor/conversation-store.mjs`：

```js
// runtime/monitor/conversations/<workflowId>.jsonl  每行一条消息
// 追加写，用 appendFileSync（与 agent-runner.mjs:29-32 的 appendRawLog 同风格）
export function createConversationStore({ runtimeRoot }) {
  return {
    append(workflowId, message),   // { message_id, role, content, intent_draft?, created_at }
    list(workflowId, { limit }),   // 读取最近 N 条
    get(workflowId, messageId),    // 二段提交时按 id 取回 intent_draft
  };
}
```

`role` 取值：`'user' | 'assistant' | 'system'`。
`intent_draft` 只在 assistant 消息上出现，结构见 T-4.2。

**离线模式必须可用**：不引入 PostgreSQL 依赖，纯文件即可，
这样 `databasePath` 离线 runtime（`runtime.mjs:44`）下测试能跑。

---

### 任务清单

#### T-4.1 抽象 ChatProvider（让 P4 不依赖 P2）

**新建** `monitor/chat-provider.mjs`

这是 P4 与 P2 解耦的关键。定义一个极简接口：

```js
/**
 * @typedef {Object} ChatProvider
 * @property {(input: { system: string, messages: Array<{role, content}>, timeoutMs: number })
 *            => Promise<{ text: string, raw: unknown }>} complete
 */
export function createChatProvider({ kind, projectRoot, policy }) { /* ... */ }
```

三个实现：

| kind | 实现方式 | 可用阶段 |
|---|---|---|
| `openclaw` | 复用 `agent-runner.mjs:39-41` 的参数构造，一次性 spawn `openclaw agent --agent manager-agent --message-file <tmp> --json`，读 stdout | **P4 阶段用这个** |
| `native` | 调 P2 的 `NativeExecutor`（T-2.2 产物） | P2 完成后切换 |
| `mock` | 从固定夹具返回，供单测使用 | 测试 |

由 `config/monitoring.example.json` 新增字段 `chat_provider` 决定，默认 `openclaw`。

**openclaw 实现的注意点**：

- 不要复用 `runAgentProcess`（`agent-runner.mjs:34`）——那个函数绑定了
  dispatch/cycle/status/result 六件套落盘契约（`dispatcher.mjs:18-30`），对话场景用不上。
  写一个轻量的 `spawnOnce()`，只要 stdout。
- 仍然要用 `openClawSpawnSpec`（`process-utils.mjs`）构造命令，别自己拼路径。
- 超时用 `policy.manager` 里的配置，别硬编码。失败时返回结构化错误，不要抛裸异常。

**测试**：`tests/monitor-chat-provider.test.mjs`，只测 `mock` 与参数构造，不真跑 OpenClaw。

**提交**：`workbuddy: 新增 monitor 对话 provider 抽象层`

---

#### T-4.2 意图识别与 intent_draft 契约

**新建** `contracts/conversation-intent.schema.json`

Manager 收到用户自由文本后，必须回一个**双段结构**：给人看的话 + 机器可执行的意图草案。

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://openclaw-sdlc-multi-agent/contracts/conversation-intent.schema.json",
  "title": "ConversationIntentDraft",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "reply_to_user", "intent"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "reply_to_user": { "type": "string", "minLength": 1 },
    "intent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type"],
      "properties": {
        "type": { "enum": ["ANSWER", "CREATE", "CHANGE", "DECISION"] },
        "summary_for_user": { "type": "string" },
        "project_path_abs": { "type": "string" },
        "original_request": { "type": "string" },
        "route_plan": { "type": "object" },
        "decision_id": { "type": "string", "pattern": "^DEC-[A-Za-z0-9][A-Za-z0-9-]*$" },
        "choice": { "type": "string" },
        "notes": { "type": "string" }
      }
    }
  }
}
```

`intent.type` 四种含义：

| type | 含义 | 是否需要用户二次确认 |
|---|---|---|
| `ANSWER` | 纯答疑，不改状态 | **否**，直接显示 |
| `CREATE` | 新建工作流 | **是** |
| `CHANGE` | 改路线 | **是** |
| `DECISION` | 代答一个待审批项 | **是** |

**注意 `intent.type` 的三个可执行值刻意与 `manager-request.schema.json:11` 的
`request_type` 枚举保持完全一致**，这样二段提交时可以直接映射，不需要翻译表。

**提示词**：新建 `templates/conversation-intent-prompt.md`，要求 Manager：
- 必须输出**单个 JSON 对象**，无 markdown 代码块包裹（与现有 Agent JSON 约定一致，
  参考 `scripts/runtime-core/json-ingestion.mjs` 的解析容错）
- `reply_to_user` 用中文，是给人看的自然语言
- 不确定用户意图时一律输出 `ANSWER` 并在 `reply_to_user` 里反问，**禁止猜测后直接产出 CHANGE**
- 提出 `CHANGE` 时，`route_plan` 必须是完整计划，不是 diff

**校验**：复用现有 ajv 装配方式（仓库已依赖 `ajv` + `ajv-formats`，见 `package.json`）。
校验失败时**不要重试无限次**——沿用 JSON 修复的既有上限概念，失败即降级为
`{ type: 'ANSWER', reply_to_user: '（解析失败原文）' }`，把原始文本照直给用户看，不要静默吞掉。

**提交**：`workbuddy: 定义对话意图契约与提示词模板`

---

#### T-4.3 抽出共享的授权校验（消除两套实现）

**问题**：`manager-request-queue.mjs:12-24` 的 `assertRequest` 是文件队列私有的。
P4 走 HTTP 不经过文件队列，如果各写各的校验，两条路的安全强度会漂移。

**做法**：把 `assertRequest` 从 `manager-request-queue.mjs` 提取到
**新建** `scripts/stategraph/request-authorization.mjs`，导出：

```js
export function assertAuthorizedRequest(value, { projectRoot, targetProjectRoot }) { /* 原逻辑原样搬 */ }
```

然后 `manager-request-queue.mjs` 改为 import 它，**行为必须零变化**。

**验证零变化**：`tests/stategraph-manager-queue.test.mjs` 现有断言必须全部继续通过，
不许改测试来迁就重构。

**提交**：`workbuddy: 抽出共享的请求授权校验模块`

---

#### T-4.4 对话 API（第一段：产出草案，不改状态）

**文件**：`monitor/server.mjs`

| 方法 | 路径 | 入参 | 说明 | 令牌 |
|---|---|---|---|---|
| GET | `/api/workflows/:id/messages` | `?limit=50` | 读历史对话 | 只读 |
| POST | `/api/workflows/:id/messages` | `{ text }` | 发消息，返回草案 | runtime |

`POST` 的处理流程：

1. 校验 `text` 非空且长度 ≤ 4000（超长直接 400 `MESSAGE_TOO_LONG`，别送给 LLM 烧 token）
2. `conversationStore.append(id, { role: 'user', content: text })`
3. 组装提示词：
   - system = `templates/conversation-intent-prompt.md` 内容
   - 当前工作流上下文 = **复用 `runtime.managerContext(id)`**（`runtime.mjs:163`），
     它内部走 `createCompactManagerContext`（`manager-context.mjs:1`），
     已经做好了 `prompt_max_chars` 裁剪和字段精简，**不要自己另写一套上下文组装**
   - 最近 N 轮对话 = `conversationStore.list(id, { limit: policy.manager.recent_events })`
4. `chatProvider.complete(...)`
5. 按 `conversation-intent.schema.json` 校验
6. `conversationStore.append(id, { role: 'assistant', content: reply_to_user, intent_draft })`
7. `hub.publish('conversation-message', {...}, { source: 'MONITOR_CHAT' })` 让 SSE 推给所有客户端
8. 返回 `{ ok: true, message_id, reply_to_user, intent }`

**关键约束（再强调一次）**：这个接口**绝对不能**调用任何 `runtime.*` 写方法。
它是只读 + 产出草案。有人在 code review 时看到这个接口里出现
`runtime.revise` / `runtime.approve` / `runtime.bootstrapConfirmed`，就是实现错了。

**并发**：同一 workflow 同时只允许一个对话请求在飞，
用一个内存 `Map<workflowId, Promise>` 做串行化即可（对话不需要跨进程锁，
因为它不碰 state；真正的写操作在 T-4.5，那里有 `withWorkflowLock`）。

**提交**：`workbuddy: monitor 落地对话接口与意图草案生成`

---

#### T-4.5 意图确认 API（第二段：人授权后才执行）

**文件**：`monitor/server.mjs`

| 方法 | 路径 | 入参 | 令牌 |
|---|---|---|---|
| POST | `/api/workflows/:id/messages/:messageId/confirm` | `{ actor, notes? }` | `DECISION` 用 **human**，其余用 **runtime** |

处理流程：

1. `conversationStore.get(id, messageId)` 取回 `intent_draft`；不存在返回 404
2. 若该 message 已确认过（store 里记了 `confirmed_at`）返回 409 `INTENT_ALREADY_CONFIRMED`
   —— **幂等很重要**，用户手抖双击不能触发两次状态变更
3. `intent.type === 'ANSWER'` 时返回 400 `INTENT_NOT_ACTIONABLE`
4. 校验 `actor` 匹配 `^human:[A-Za-z0-9._-]+$`，不合法 400（与 P3 的 `:468-469` 同规则）
5. 组装成标准请求信封，**补上只有服务端能补的授权字段**：
   ```js
   const envelope = {
     schema_version: 1,
     request_id: `REQ-${randomUUID()}`,
     request_type: intent.type,          // CREATE | CHANGE | DECISION
     workflow_id: id,
     submitted_by: 'manager-agent',
     submitted_at: new Date().toISOString(),
     ...intentPayload,
     user_authorized: { confirmed: true, actor, message: notes ?? intent.summary_for_user },
   };
   ```
6. `assertAuthorizedRequest(envelope, ...)`（T-4.3 的共享校验）
7. 按类型分发到 runtime，**与 `manager-request-queue.mjs:96-106` 完全相同的映射**：
   - `CREATE` → `runtime.bootstrapConfirmed({ workflowId, request, routePlan })`
   - `CHANGE` → `runtime.revise(workflowId, {...})`
   - `DECISION` → `runtime.approve(workflowId, {...})`
8. store 里标记 `confirmed_at` / `confirmed_by`
9. `await refresh()` + `hub.publish('command-result', ...)`

**为什么不复用文件队列**：文件队列（`manager-request-queue.mjs`）是为 OpenClaw 插件设计的
异步扫描模型，HTTP 请求需要同步返回结果。两者共用**校验逻辑**（T-4.3）就够了，
不必共用**投递机制**。P2 收尾时（T-2.5）再决定是否删除文件队列。

**测试**：新建 `tests/monitor-conversation.test.mjs`，用 `mock` provider + 离线 runtime，
覆盖四条关键路径：
- `ANSWER` 意图不产生任何状态变更（断言 `revision` 不变）
- `DECISION` 意图在确认前不改状态、确认后状态推进
- 重复确认返回 409
- 伪造的 `actor: 'bot:xxx'` 被拒绝

**提交**：`workbuddy: monitor 落地意图确认与二段提交执行`

---

#### T-4.6 前端对话面板

**文件**：`monitor/ui/index.html`、`monitor/ui/app.js`、`monitor/ui/styles.css`

布局调整为三栏：

```
┌──────────┬─────────────────────────┬──────────────┐
│ 工作流列表 │   对话区（主区域）        │  流程状态面板  │
│          │   ┌───────────────────┐ │  步骤进度      │
│ + 新建   │   │ 消息流（user/asst）│ │  待审批卡片    │
│          │   └───────────────────┘ │  （P3 已做）   │
│          │   ┌───────────────────┐ │  操作按钮      │
│          │   │ 输入框 + 发送      │ │  （P3 已做）   │
│          │   └───────────────────┘ │              │
└──────────┴─────────────────────────┴──────────────┘
```

实现要点：

- **CSP 不放宽**：`index.html:7` 保持 `script-src 'self'`，
  所有事件用 `addEventListener` 绑定（`app.js:32` 已是这个风格）。
- **消息渲染必须转义**：LLM 输出是不可信内容，
  用 `textContent` 而不是 `innerHTML` 写入消息正文。
  如果要支持换行，用 `white-space: pre-wrap` 走 CSS，**不要**自己拼 `<br>`。
  这是 P4 最容易引入 XSS 的地方。
- **意图卡片**：assistant 消息带 `intent.type !== 'ANSWER'` 时，
  在气泡下方渲染一张确认卡片：
  ```
  ┌────────────────────────────────────┐
  │ 待确认操作：修改执行路线              │
  │ 摘要：TTL 由 10 分钟改为 5 分钟，     │
  │      新增缓存击穿保护步骤             │
  │ 审批人：[human:liuxu        ]        │
  │ [ 确认执行 ]  [ 忽略 ]               │
  └────────────────────────────────────┘
  ```
  点「确认执行」→ 调 T-4.5 的接口。确认后卡片变灰并显示结果。
- **审批同界面**：P3 已有的 `pending_approval` 卡片保留在右栏，
  但**同时**在对话流里插一条 system 消息提示「流程已暂停，等待审批」，
  让用户在对话区就能感知，不用来回扫视。
  这条 system 消息的内容可以直接用 `manager-context.mjs:17-25` 的
  `manager_notification.message` 字段，那里已经写好了中文文案。
- **SSE 复用**：对话消息通过已有的 EventSource 通道推送（事件类型 `conversation-message`），
  不要新开一条连接。`app.js` 现有的 `renderKey` 去重机制（`app.js:26-28`）
  要把消息数量纳入 key，否则新消息不触发重绘。
- **降级**：`client.chat_enabled === false` 时隐藏整个对话栏，退回 P3 的两栏布局。

**测试**：扩充 `tests/monitor-static-dashboard.test.mjs`：
断言 CSP 未放宽、`app.js` 无 `innerHTML` 写消息正文、新增 DOM id 存在。

**提交**：`workbuddy: monitor 前端增加对话面板与意图确认卡片`

---

#### T-4.7 配置与文档

- `monitor/config.mjs`：新增 `chatEnabled`（env `MONITOR_CHAT`，默认 false）、
  `chatProvider`（默认 `'openclaw'`）、`chatMaxTurns`（默认 20）。
  **注意 `:76`、`:78` 那两个硬编码 false 的开关在 T-3.1 已经改成读 env 了，
  新开关照同样方式写，不要再硬编码。**
- `/api/client-config`（`server.mjs:269-278`）增加 `chat_enabled` 字段。
- `README.md`：新增「网页版 Agent 对话」章节。
- `docs/monitoring.md`：补对话 API 表与二段提交安全模型说明。
- `scripts/start-monitor.ps1` / `.sh`：T-3.6 已加 `-Interactive`，
  再加一个 `-Chat` / `--chat` 开关。

**提交**：`workbuddy: 同步网页版 Agent 对话的配置与文档`

---

### P4.4 与 P2 的关系

**P4 不依赖 P2，但 P2 会让 P4 变好。**

| 阶段 | ChatProvider 实现 | 效果 |
|---|---|---|
| P4 完成，P2 未做 | `openclaw` | 对话可用，但每轮要 spawn 一次 OpenClaw 进程，延迟较高（秒级） |
| P2 完成后 | `native` | 改 `config` 一个字段即可切换，支持流式输出，延迟大幅下降 |

这就是 T-4.1 一定要先做 provider 抽象的原因——**它把 P4 的交付时间从「P2 之后」提前到了「P3 之后」**。

P2 收尾（T-2.5）时需要额外做一件事：把 `chat_provider` 默认值从 `openclaw` 改为 `native`，
并删除 `extensions/stategraph-webchat/`（其功能已被 P4 完全覆盖）。

### P4.5 流式输出（可选增强，不在验收范围）

`openclaw` provider 拿不到流式 token（CLI 一次性返回）。
若 P2 完成后想做打字机效果：`chatProvider.complete` 增加可选的 `onToken` 回调，
经由 `hub.publish('conversation-token', ...)` 推送。
**不要为了流式去改 SSE 协议**，现有 `MonitorEventHub`（`event-hub.mjs:9`）的
publish/subscribe 已经够用。

### P4 验收标准

- [ ] `npm test` 全绿
- [ ] `MONITOR_INTERACTIVE=true MONITOR_CHAT=true npm run monitor:start` 后，
      在网页对话框输入「给 order-service 加 Redis 缓存」→ 收到 Manager 回复 +
      `CREATE` 意图卡片 → 点确认 → 工作流被创建
- [ ] 流程跑到路线确认时，对话区出现 system 提示，右栏出现审批卡片，
      在对话框输入「TTL 改成 5 分钟」→ 收到 `CHANGE` 意图卡片 → 确认后路线更新
- [ ] 纯提问「现在跑到哪一步了」返回 `ANSWER`，**`revision` 不变**（这条必须断言）
- [ ] 同一条意图重复确认返回 409
- [ ] `actor` 传 `bot:foo` 被 400 拒绝
- [ ] 关闭 `MONITOR_CHAT` 时对话栏消失，其余功能不受影响
- [ ] 在对话里诱导 Manager 输出恶意 HTML（如 `<img src=x onerror=alert(1)>`），
      页面不执行脚本（XSS 回归测试）

---

## P1 · 启用 LangGraph 高级能力

> P1 建议在 P3、P4 之后做（需要 GUI 与对话来验证扇出效果），
> 也可与它们并行但必须独立提交。


### P1 的四个子能力与优先级

| 子能力 | 价值 | 前置条件 | 建议 |
|---|---|---|---|
| A. 通道 reducer 改造 | 所有并行能力的地基 | 无 | **必做，第一步** |
| B. 真并行（Send 扇出） | 兑现 `parallelism.enabled` | A | **必做** |
| C. time-travel / 分叉重跑 | 排障效率 | 无（可独立做） | **建议做** |
| D. 官方 interrupt 替换现有审批 | 语义更贴合 | A、B 稳定后 | **建议暂缓**，理由见下 |

> **关于 D 的判断**：现有审批机制（graph 结束 → 外部调 `approve()` → 重新 invoke）
> 已经和 Control Kernel 双写、能力令牌、事件哈希链深度耦合，且经过 `stategraph-trust-boundary.test.mjs` 等测试固化。
> 官方 `interrupt()` 会把等待状态放进 checkpoint 的 pending writes，与 Kernel 的 `WAITING_HUMAN` 投影产生第二个真相源。
> **收益小、风险大，本方案不建议在本轮做。** 若后续要做，单独立项。

---

#### T-1.1 改造状态通道 reducer（并行地基）

**文件**：`scripts/stategraph/state.mjs`

当前所有通道都是 `replace`。需要区分三类：

1. **仍用 replace**（单点写入，标量/整体替换语义）：
   `schemaVersion` `workflowId` `request` `workflowTitle` `targetProjectRootAbs` `baseCommit` `candidateCommit`
   `createdAt` `updatedAt` `phase` `condition` `outcome` `statusReason` `routePlan` `confirmedRoutePlan`
   `approvalPlan` `pendingApproval` `steps` `currentStepIndex` `activeTaskId` `operatorCommand`
   `routeChangeCommand` `action` `lastAction` `stopReason` `parallelism`

2. **改为按 key 合并**（并行分支各写自己那份）：
   - `tasks` → 按 `task_id` 合并，同 id 后写覆盖，顺序按首次出现顺序稳定：
     ```js
     const mergeById = (key) => Annotation({
       reducer: (current = [], next) => {
         if (!Array.isArray(next)) return next;
         const index = new Map(current.map((item) => [item[key], item]));
         const order = current.map((item) => item[key]);
         for (const item of next) {
           if (!index.has(item[key])) order.push(item[key]);
           index.set(item[key], item);
         }
         return order.map((id) => index.get(id));
       },
       default: () => [],
     });
     ```
     用于 `tasks`（key = `task_id`）和 `taskGroups`（key = `group_id`）。
   - **重要**：现有节点大量写 `tasks: [...state.tasks, task]` 和 `tasks: replaceTask(state, updated)`（`graph.mjs:19-25`）。
     换 reducer 后这些写法**仍然正确**（全量数组进来，按 id 合并结果等价）。
     但为了让并行分支只提交增量，`dispatch`/`reconcile` 节点应改为只返回**变更的那一个 task**：
     `tasks: [updatedTask]`。改完后必须验证 `stategraph-runtime.test.mjs` 全绿。

3. **改为追加**（`revision` / `events` 特殊处理，见 T-1.2）

4. **`candidateHistory` `routeHistory` `managerReports`** → 改为 append 语义：
   ```js
   const append = () => Annotation({
     reducer: (current = [], next) => Array.isArray(next) ? [...current, ...next] : current,
     default: () => [],
   });
   ```
   同样要把节点里的 `managerReports: [...state.managerReports, report]`（`graph.mjs:531`）改为 `managerReports: [report]`。
   `candidateHistory` 见 `graph.mjs:65-79` 的 `candidatePatch`。

**测试**：新建 `tests/stategraph-state-reducer.test.mjs`，覆盖：
同 superstep 两个分支各写一个不同 task → 合并后 2 个；写同一个 task → 后写生效；append 通道不丢数据。

**提交**：`workbuddy: 状态通道引入合并与追加型 reducer 以支持并行写入`

---

#### T-1.2 事件哈希链的并行安全化

**文件**：`scripts/stategraph/events.mjs`、`scripts/stategraph/graph.mjs`

问题：`appendStateEvent`（`events.mjs:23`）在节点内计算 `revision` 和 `previous_event_hash`，
并行分支会读到相同前序，链必然断。

**方案（推荐，改动最小）：把「链化」从节点内挪到 reducer 内。**

1. 节点侧：`appendStateEvent` 只产出**未链化的事件草稿**（不含 `revision` / `previous_event_hash` / `event_hash`）：
   ```js
   const draft = { schema_version: 1, workflow_id, type, payload, occurred_at };
   return { ...changes, events: [draft], lastAction: type, updatedAt: occurredAt };
   ```
2. 通道侧：`events` 用一个「链化 reducer」，在合并时按 `occurred_at` + 稳定排序后逐条补齐
   `revision` / `previous_event_hash` / `event_hash`：
   ```js
   const eventChain = () => Annotation({
     reducer: (current = [], next) => {
       if (!Array.isArray(next) || next.length === 0) return current;
       const drafts = [...next].sort((a, b) =>
         a.occurred_at === b.occurred_at ? String(a.type).localeCompare(String(b.type))
                                         : String(a.occurred_at).localeCompare(String(b.occurred_at)));
       let revision = current.at(-1)?.revision ?? 0;
       let previous = current.at(-1)?.event_hash ?? null;
       const chained = [];
       for (const draft of drafts) {
         revision += 1;
         const body = { ...draft, revision, previous_event_hash: previous };
         const event = { ...body, event_hash: sha256(body) };
         previous = event.event_hash;
         chained.push(event);
       }
       return [...current, ...chained];
     },
     default: () => [],
   });
   ```
3. `revision` 通道改为从 `events` 派生。最简单的做法是保留 `revision` 通道但用
   `reducer: (current, next) => Math.max(current ?? 0, next ?? 0)`，
   并让所有节点不再手写 revision，改由 `syncKernelFacts` 和 `publicResult` 从 `state.events.at(-1).revision` 读取。

**兼容性检查清单**（改完必须逐条确认）：

- [ ] `auditEventChain`（`events.mjs:45`）逻辑不变，仍能通过
- [ ] `syncKernelFacts`（`graph.mjs:176-191`）的 `eventCursor` 增量逻辑仍成立
      （它按 `next.events.slice(cursor)` 取增量，链化后事件仍是有序追加，逻辑不变）
- [ ] `scripts/control-kernel/kernel.mjs` 的 `appendEvent` 收到的事件结构未变
- [ ] `runtime.audit()`（`runtime.mjs:146`）返回 `ok: true`
- [ ] `tests/control-kernel-events.test.mjs` 全绿

**测试**：扩充 `tests/stategraph-state-reducer.test.mjs`，
构造两个并行分支各产出 1 个事件草稿，断言合并后 revision 连续、hash 链闭合、`auditEventChain().ok === true`。

**提交**：`workbuddy: 事件哈希链改为在 reducer 内链化以支持并行分支`

---

#### T-1.3 实现真并行：split_tasks 用 Send 扇出

**文件**：`scripts/stategraph/graph.mjs`

**设计**：

1. `prepare_step` 节点在 `parallelism.enabled` 且当前 step 允许并行时，
   不再创建单个 task，而是创建一个 **task group**：
   ```js
   {
     group_id: `TG-${stepId}-R${executionRound}`,
     step_id: stepId,
     status: 'PENDING_SPLIT',
     slots: [ /* 每个 slot 一个 task 草稿 */ ],
   }
   ```
   **本轮先只支持一种并行场景**：同一个 step 内、由 route-plan 显式声明 `parallel_slots: N` 时才拆分。
   route-plan schema（`contracts/route-plan.schema.json`）需要加这个可选字段，
   `policy.mjs:140-146` 编译时透传。**不声明就走原有串行路径，行为零变化。**

2. `split_tasks` 节点改为返回 `Send` 数组扇出到 `dispatch`：
   ```js
   import { Send } from '@langchain/langgraph';
   // ...
   splitTasks(state) {
     if (!dependencies.policy.parallelism?.enabled) return { action: 'dispatch' };
     const group = state.taskGroups.find((item) => item.status === 'PENDING_SPLIT');
     const limit = dependencies.policy.parallelism.max_parallel;
     const slots = group.slots.slice(0, limit);
     return slots.map((slot) => new Send('dispatch', { ...state, activeTaskId: slot.task_id }));
   }
   ```
   **注意**：`Send` 要生效，`split_tasks` 的出边必须改成 conditional edge 而不是 `addEdge('split_tasks', END)`。
   改法：
   ```js
   .addConditionalEdges('split_tasks', (state) => state.__sends ?? END)
   ```
   或者更符合官方用法：把 `splitTasks` 本身作为 conditional edge 的路由函数，
   即 `.addConditionalEdges('prepare_step', splitRouter)`，`splitRouter` 返回 `Send[]` 或字符串。
   **动工前务必查阅 `node_modules/@langchain/langgraph` 的 Send 用法文档或类型定义确认签名**，
   1.4.9 的 API 与网上老教程可能有差异。

3. `dispatch` 节点改为只返回自己那一个 task 的增量（依赖 T-1.1 的 mergeById reducer）：
   ```js
   return appendStateEvent(state, { tasks: [started], stopReason: 'TASK_DISPATCHED' }, ...);
   ```
   **不能再返回全量 `replaceTask(state, started)`**，否则并行分支互相覆盖。

4. `merge_tasks` 节点：当 group 内所有 slot 都到达终态时，
   汇总为一个 step 结果，`status: 'READY_TO_MERGE'` → 走原有 `evaluate` 逻辑。
   汇总规则（**必须在代码里写死，不能让 Agent 决定**）：
   - 任一 slot 失败 → 整组失败，走 `failurePatch`
   - 全部成功 → 取所有 slot 的 `result` 合并进一个数组交给 `buildLocalGate`
   - **Git 层面**：每个 slot 有独立 worktree（`git-worktree.mjs:71-80` 按 `run_id` 哈希隔离），
     合并时要么串行 cherry-pick 到候选分支、要么只允许「不产生代码变更的 kind」并行。
     **本轮建议限制为后者**：只允许 `TEST` / `CODE_REVIEW` / `REQUIREMENTS` 这类只读 kind 并行，
     `DEVELOPMENT` 强制串行。在 `policy.mjs` 的 `assertRouteRules` 里加这条校验，
     错误码 `ROUTE_PLAN_PARALLEL_KIND_FORBIDDEN`。

5. `syncKernelFacts` 的 `eventCursors` Map（`graph.mjs:702`）在并行下有竞态：
   多个分支同时读同一个 cursor 会重复写 Kernel 事件。
   **修复**：把游标从 Map 改为「从 state.events 里已同步的最后一条的 revision」推导，
   或给 `kernel.appendEvent` 加基于 `event_hash` 的幂等去重（查 Kernel 是否已有该 hash）。
   推荐后者，改 `scripts/control-kernel/kernel.mjs` 的 `appendEvent` 为 upsert 语义。

6. `runtime.mjs:76` 的 `recursionLimit: 20` 在扇出后可能不够（每个 Send 算一次），
   改为从 policy 读：`recursionLimit: selectedPolicy.recursion_limit ?? 20`，
   并在 `config/stategraph-policy.json` 加 `"recursion_limit": 64`。

**测试**：
- 改写 `tests/stategraph-parallel-interface.test.mjs`：
  删掉「抛 PARALLEL_NOT_IMPLEMENTED」断言，改为断言 `parallelism.enabled=true` 时返回 `Send[]`。
  **在 commit message 里写明这个断言是被有意替换的。**
- 新建 `tests/stategraph-parallel-execution.test.mjs`：
  用打桩 dispatcher（不真 spawn）跑一个 3 slot 的并行 TEST step，
  断言 3 个 task 都进 state、事件链完整、merge 后 step 完成。

**提交**：`workbuddy: 用 Send 实现 split_tasks 真并行扇出与 merge_tasks 汇总`

---

#### T-1.4 time-travel 与分叉重跑

**文件**：`scripts/stategraph/runtime.mjs`、`monitor/server.mjs`、`monitor/ui/app.js`

LangGraph 的 checkpointer 天然支持历史回溯，只是当前 runtime 没暴露。

1. `runtime.mjs` 新增三个方法：
   ```js
   async function history(workflowId, { limit = 50 } = {}) {
     await ready;
     const values = [];
     for await (const snapshot of graph.getStateHistory(config(workflowId), { limit })) {
       values.push({
         checkpoint_id: snapshot.config?.configurable?.checkpoint_id ?? null,
         revision: snapshot.values?.revision ?? null,
         phase: snapshot.values?.phase ?? null,
         condition: snapshot.values?.condition ?? null,
         last_action: snapshot.values?.lastAction ?? null,
         next: snapshot.next,
         created_at: snapshot.createdAt ?? null,
       });
     }
     return values;
   }

   async function stateAt(workflowId, checkpointId) {
     await ready;
     const snapshot = await graph.getState({
       configurable: { thread_id: workflowId, checkpoint_ns: '', checkpoint_id: checkpointId },
     });
     return snapshot?.values ?? null;
   }

   async function forkFrom(workflowId, checkpointId) {
     // 从历史检查点重新 invoke，产生新分支
     await ready;
     if (!skipAuthority) assertAuthority(projectRoot, 'runtime', runtimeCapability);
     return withWorkflowLock(projectRoot, workflowId, async () => {
       const value = await graph.invoke(null, {
         configurable: { thread_id: workflowId, checkpoint_ns: '', checkpoint_id: checkpointId },
         recursionLimit: 20,
       });
       return { ...publicResult(value), state: value };
     });
   }
   ```
   **动工前必须先在离线 MemorySaver 上跑通 `getStateHistory` 的实际返回结构**，
   1.4.9 的 snapshot 字段名以实际为准（写一个一次性脚本打印出来看）。

2. **`forkFrom` 的严重风险**：从历史点重跑会让 Control Kernel 收到「revision 倒退」的事实，
   与 `kernel` schema 里已有的 run/task 记录冲突。

   **必须的护栏**（不做就不要开放这个功能）：
   - `forkFrom` 只允许在 `condition === 'HOLD'` 或 `'TERMINAL'` 时调用，ACTIVE 时拒绝（`WORKFLOW_FORK_BUSY`）
   - fork 前在 Kernel 里给原 run 打上 `forked_at` 标记
   - fork 产生的新事件在 `payload` 里带 `forked_from_checkpoint_id`
   - **或者更保守：本轮只做只读的 `history` / `stateAt`，不做 `forkFrom`。**
     排障场景 90% 只需要「看当时的状态」，不需要真的重跑。**推荐先只做只读部分。**

3. Monitor 侧：
   - `GET /api/workflows/:id/history` → `runtime.history(id)`
   - `GET /api/workflows/:id/history/:checkpointId` → `runtime.stateAt(id, cid)`
   - 前端在上下文面板加「历史」折叠区，列出 checkpoint 时间线，点击查看当时状态 JSON。
   - `forkFrom` 若实现，对应 `POST /api/workflows/:id/fork`，需 runtime 令牌 + 二次确认。

**测试**：`tests/stategraph-history.test.mjs`，离线模式下 bootstrap → run 数次 → 断言 history 条数与 revision 递减顺序。

**提交**：`workbuddy: runtime 暴露 checkpoint 历史查询并接入 monitor`

### P1 验收标准

- [ ] `npm test` 全绿（含被有意改写的 parallel-interface 用例）
- [ ] `config/stategraph-policy.json` 把 `parallelism.enabled` 改为 `true`、`max_parallel: 3`
      后，一个含 3 slot TEST step 的 workflow 能并行跑完，事件链审计 `ok: true`
- [ ] 改回 `enabled: false` 后行为与改造前完全一致（回归保护）
- [ ] Monitor 上能看到某个 workflow 的 checkpoint 历史时间线
- [ ] `runtime.audit()` 在并行场景下仍返回 `ok: true`

---

## P2 · 脱离 OpenClaw，节点原生执行 Agent

> **这是本方案中工程量最大、风险最高的部分。**
> 它与「LangGraph 换不换」其实无关——本质是「自己实现一个 Agent 执行器来替代 OpenClaw」。
> 强烈建议 P3、P1 稳定运行一段时间后再启动 P2，且 P2 内部要分多个 PR。

### 要替换掉什么

OpenClaw CLI 当前为项目提供了这些能力，全部需要重新实现或明确放弃：

| OpenClaw 提供的能力 | 当前依赖位置 | P2 后如何处理 |
|---|---|---|
| LLM 调用与多轮 agent loop | `agent-runner.mjs:39-41` 的 `openclaw agent` | 需自建：LangChain `ChatModel` + tool calling 循环 |
| Agent 人设加载 | `agents/<id>/workspace/*.md` 被 OpenClaw 读 | 需自建：读同样的 md 拼 system prompt |
| 工具集与权限 | `agents/<id>/workspace/TOOLS.md` + OpenClaw 内置工具 | 需自建：定义 LangChain tools，实现文件读写/命令执行/git |
| 会话持久化 | `--session-id` + OpenClaw session 存储 | 需自建：或直接复用 LangGraph checkpoint |
| 沙箱隔离 | `sandbox_mode` + `test-sandbox-policy.json` | 需自建：`scripts/stategraph/sandbox-runtime.mjs` 已有部分逻辑 |
| 结构化 JSON 输出与重试 | `--json` + `output-ingestion.mjs` 的修复循环 | 部分复用：ingestion 逻辑可保留，生成侧要重写 |
| 模型路由 | `config/agent-models.example.json` | 需自建：映射到 LangChain model provider |
| MCP / skill 接入 | OpenClaw 插件体系 | **可能要放弃**，或自己接 MCP client |

**决策点：这是一次「重写执行层」，不是「迁移」。** 动工前必须确认：
1. 是否真的需要脱离 OpenClaw？（现有链路已经能跑通，脱离的收益是什么？）
2. 内网环境有哪些可用的 LLM endpoint？（`config/deepseek-responses-provider.example.json` 暗示走的是 DeepSeek 兼容接口）
3. 工具权限模型谁来设计？（这是安全边界，不能随便实现）

### 分阶段拆解（每阶段独立 PR）

#### T-2.1 抽象 AgentExecutor 接口（不改行为）

**目标**：先在不动任何行为的前提下，把「怎么执行 Agent」抽成可替换接口。

**文件**：新建 `scripts/stategraph/agent-executor/index.mjs`

```js
// 契约：
// start({ task, cycle, paths, timeoutSeconds, ... }) -> { launcher_pid | executor_handle }
// reconcile(task) -> { kind: 'WAITING'|'JSON_REPAIR'|'ERROR'|'DONE', task, ... }
export function createOpenClawExecutor({ ... }) { /* 包装现有 launchDetachedAgent */ }
```

- `dispatcher.mjs:72` 的 `createForcedDispatcher` 已经接受 `launch` 注入（默认 `launchDetachedAgent`），
  这就是天然的接缝。把 `launch` 参数升级为完整的 executor 对象。
- 本阶段**只做重构，行为零变化**，`npm test` 必须全绿且无需改任何测试断言。

**提交**：`workbuddy: 抽象 AgentExecutor 接口为原生执行器预留接缝`

---

#### T-2.2 实现 NativeExecutor 骨架（单个 kind 试点）

**文件**：新建 `scripts/stategraph/agent-executor/native.mjs`

- 选**最简单的一个 kind 做试点**，推荐 `REQUIREMENTS`（纯文本产出、不改代码、不需要 git 提交）。
- 实现内容：
  1. 从 `agents/requirement-agent/workspace/` 读 `AGENTS.md` / `IDENTITY.md` / `SOUL.md` / `rules/*`，
     按固定顺序拼成 system prompt（拼装规则参考 `agents/packages/builtin/*.json` 的
     `assembly.include_common_rules`，为 true 时还要拼 `agents/common/`）。
  2. 用 LangChain 的 chat model（需新增依赖，如 `@langchain/openai` 走兼容接口）调用 LLM。
  3. 输出按 `contracts/result.schema.json` 校验，写入 `paths.result_path_abs`。
     **落盘路径和文件名必须与现有 `dispatcher.mjs:18-30` 完全一致**，这样 `reconcile` 侧零改动。
  4. 心跳写 `paths.status_path_abs`，格式对齐现有 `agent-runner.mjs` 的写法。
- 通过环境变量或 policy 开关选择 executor：
  `config/stategraph-policy.json` 加 `"executor": { "default": "openclaw", "overrides": { "REQUIREMENTS": "native" } }`。
- **保留 OpenClaw 路径可用**，两条路径长期共存，逐个 kind 迁移。

**测试**：`tests/stategraph-native-executor.test.mjs`，用假 LLM（返回固定 JSON）验证落盘格式与现有 reconcile 兼容。

**提交**：`workbuddy: 实现原生 Agent 执行器骨架并试点 REQUIREMENTS`

---

#### T-2.3 工具层（这是最难的部分，必须单独设计）

在做之前**必须先产出一份工具权限设计文档**（`docs/plan/08-native-agent-tools.md`），至少回答：

- 哪些工具？（读文件 / 写文件 / 执行命令 / git 操作 / 搜索）
- 每个 kind 的 Agent 允许哪些工具？（对齐 `agents/<id>/workspace/TOOLS.md` 现有声明）
- 路径边界怎么强制？（现有 `dispatcher.mjs:79` 的 `DISPATCH_ARTIFACT_ESCAPE`、
  `git-worktree.mjs:88` 的 `TASK_WORKTREE_ESCAPE` 是参考基线，工具层要有等强度的边界检查）
- 命令执行的沙箱策略？（复用 `config/test-sandbox-policy.json` 还是重新设计）
- 超时、输出截断、递归深度限制？

**这份文档评审通过前不要写工具层代码。**

---

#### T-2.4 逐 kind 迁移

顺序建议（从安全到危险）：
`REQUIREMENTS` → `CODE_REVIEW` → `ARCHITECTURE` / `DESIGN` → `TEST` → `MANAGER_ANALYSIS` → `DEVELOPMENT` → `RELEASE`

每迁移一个 kind：
1. 在 policy 的 `executor.overrides` 里切换
2. 跑一遍完整 workflow 端到端验证
3. 单独 commit
4. 保留回滚开关（改回 `openclaw` 即可）

---

#### T-2.5 收尾

全部 kind 迁移完成且稳定运行后：
- 移除 `agent-runner.mjs` 的 OpenClaw spawn 分支（或保留为 legacy executor）
- 把 `config` 里的 `chat_provider` 默认值由 `openclaw` 改为 `native`（P4 的 T-4.1 已预留该开关）
- 移除 `extensions/stategraph-webchat/` 插件（其对话入口功能已被 P4 完全覆盖，
  **必须确认 P4 已上线并稳定，否则会直接失去对话能力**）
- 评估是否删除 `manager-request-queue.mjs` 的文件队列投递机制
  （P4 走 HTTP 同步投递，文件队列在无 OpenClaw 后可能无消费者；
  但 `assertAuthorizedRequest` 已在 T-4.3 抽成共享模块，删队列不影响校验）
- 更新 `scripts/install.ps1` / `install.sh`（不再需要注册 OpenClaw Agent）
- 更新 README 全部安装/运行说明


> **⚠️ 到这一步会大范围触及 `agents/` 和安装脚本，
> 必须在交付时提醒用户更新已安装 Agent 或重新安装。**

### P2 验收标准

- [ ] 每个 kind 都能在 native executor 下跑通完整 workflow
- [ ] 落盘产物结构与 OpenClaw 路径产出的完全一致（可用同一套 `output-ingestion.mjs` 消费）
- [ ] `executor` 开关切回 `openclaw` 后行为不变（双路径共存验证）
- [ ] 工具层边界测试：越界读写被拒绝
- [ ] `npm test` 全绿

---

## 3. 「框架会不会太重」的正面回答

| 担心 | 事实 |
|---|---|
| LangGraph 太重 | `@langchain/langgraph` 是纯图编排库，无强制 LLM 依赖，项目已经在用了三个包，`npm ls` 无异常。**不重**。 |
| 换框架麻烦 | **不存在「换框架」**，底层已经是 LangGraph。P1 是补功能，P3 是加 UI，都不动引擎。 |
| P2 很重 | **是的，P2 确实重**，但重的原因是「自己实现 Agent 执行器」，跟用不用 LangGraph 无关。用 OpenClaw 也要写这些逻辑，只是 OpenClaw 已经帮你写了。 |
| 需要联网 | **P3 / P4 的 GUI 与对话层完全不联网**（不用 LangSmith / Studio / Platform）。P4 的 LLM 调用走已有的内网 endpoint。P2 需要能访问 LLM endpoint，这是业务需求不是框架需求。 |
| P4 会不会让 monitor 变重 | 不会。P4 新增 3 个文件（`chat-provider.mjs` / `conversation-store.mjs` / 1 个 contract），前端仍是零依赖静态资源，对话记录用 jsonl 纯文件存储，**不引入任何新 npm 依赖**。 |


---

## 4. 入口方式最终形态（P3 + P4 完成后）

```
            ┌───────────────────────────────────────────────┐
            │  浏览器 (127.0.0.1)  monitor/ui               │
            │  ┌──────────┬──────────────┬───────────────┐  │
            │  │ 工作流列表 │  对话区(P4)   │ 流程状态(P3)   │  │
            │  │ + 新建    │  输入/意图卡片 │ 步骤/审批按钮  │  │
            │  └──────────┴──────────────┴───────────────┘  │
            └───────────────────┬───────────────────────────┘
                                │ GET(SSE) + POST(x-stategraph-control)
                                │ 仅回环 + Origin 严格校验
            ┌───────────────────▼───────────────────────────┐
            │  monitor/server.mjs   持有 capability 令牌      │
            │  ┌─────────────────────┬────────────────────┐ │
            │  │ 对话层(P4)           │ 控制层(P3)          │ │
            │  │ POST /messages       │ POST /run /advance │ │
            │  │   → ChatProvider     │ POST /approve      │ │
            │  │   → intent_draft     │ POST /revise       │ │
            │  │ POST /confirm ───────┼──→ 补 user_authorized│
            │  └─────────────────────┴────────┬───────────┘ │
            └───────────────────────────────┬─┴─────────────┘
                                            │ runtime.bootstrapConfirmed
                                            │ /run/approve/revise
                           ┌────────────────▼──────────────┐
                           │  createStateGraphRuntime      │
                           │  LangGraph StateGraph         │
                           └────────────────┬──────────────┘
                              ┌─────────────┴─────────────┐
                        PostgresSaver              Control Kernel
                       (langgraph schema)          (kernel schema)

  对话记录独立存储：runtime/monitor/conversations/<workflowId>.jsonl
  （刻意不进 LangGraph state，避免污染审计事件链与 revision 序）
```

**三个入口并存，各有不可替代的职责：**

| 入口 | 适用场景 | 能力 |
|---|---|---|
| **Monitor GUI 对话区**（P4） | 日常主入口 | 自然语言下命令、看回复、确认意图、审批 |
| **Monitor GUI 控制区**（P3） | 精确操作 | 推进、审批、查审计、看历史 |
| **CLI `scripts/workflow.mjs`** | 初始化、脚本化、降级 | 生成令牌（**独占**）、CI 集成、GUI 不可用时救场 |

**CLI 入口保持完全可用，不废弃。** 三者操作同一个 runtime、同一份 checkpoint，
并发安全由 `withWorkflowLock`（`runtime.mjs:107`）的文件锁保证。

**能力令牌只能由 CLI 的 `workflow.mjs init` 生成**——
让网页能给自己造凭据等于没有凭据，这条不因 P4 而改变。


---

## 5. 快速上手（接手 AI 的第一步）

```bash
# 1. 确认在正确的分支
cd /d/MicroConnect/project/openclaw-multi-agent
git branch --show-current    # 应为 workbuddy/langgraph-native-gui-plan 或其子分支

# 2. 跑通现有测试，确认基线绿
npm test

# 3. 生成能力令牌（若尚未生成）
node scripts/workflow.mjs init --project-root .

# 4. 启动现有只读 monitor 熟悉界面
npm run monitor:start
# 浏览器打开 http://127.0.0.1:4319/

# 5. 从 P3 的 T-3.1 开始施工
#    P3 完成后接 P4（T-4.1 起），再做 P1，最后 P2
```

**每完成一个 T-x.y 任务：**

```bash
npm test
git add -A
git commit -m "workbuddy: <中文描述本次改动>"
```

---

## 6. 不要做的事

- ❌ 不要引入 LangSmith / LangGraph Studio / LangGraph Platform（用户明确要求纯本地、自研 GUI）
- ❌ 不要引入前端框架或构建工具（monitor/ui 保持零依赖静态资源）
- ❌ 不要为了并行去掉事件哈希链或 Kernel 双写（这是审计基线）
- ❌ 不要放宽 monitor 的 CSP 或回环限制
- ❌ 不要把 capability 令牌下发到浏览器
- ❌ 不要在 P1 阶段替换审批机制为官方 `interrupt()`（收益小风险大，见 P1 说明）
- ❌ 不要在 P2 之前删除 OpenClaw 相关代码
- ❌ 不要跳过 `git commit`（项目规则要求每轮完整修改后提交）

**P4 专属禁令（违反其一即为实现错误）：**

- ❌ **不要让 LLM 输出直接调用 `runtime.*` 写方法**。
  必须走 T-4.4（产出草案）→ T-4.5（人确认后补 `user_authorized`）二段提交。
  `manager-request-queue.mjs:16` 那条校验是人机权责边界的根，绕过它等于作废整套审批机制。
- ❌ **不要在服务端自动补 `user_authorized.confirmed = true` 而不经过用户点击**。
  这是上一条最常见的错误变体。
- ❌ **不要用 `innerHTML` 渲染 LLM 返回的消息正文**（XSS）。用 `textContent` + CSS `pre-wrap`。
- ❌ 不要把对话记录写进 `WorkflowState`（会污染事件哈希链与 revision 序，见 P4.3 节）
- ❌ 不要跳过 T-4.1 的 ChatProvider 抽象直接接 OpenClaw——那会让 P4 被 P2 绑架
- ❌ 不要为对话新开一条 SSE 连接（复用 `MonitorEventHub`）

