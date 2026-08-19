# 05 · 修改说明：文件级变更清单与风险

> 本文档是 [`04-implementation-plan.md`](./04-implementation-plan.md) 的配套清单，方便在施工时逐项打勾。

---

## 1. 新增文件（24 个）

### Control Kernel（9 个）

| 文件 | 阶段 | 职责 |
| --- | --- | --- |
| `scripts/control-kernel/schema.sql` | P1 | kernel + langgraph 两个 schema 的全部 DDL |
| `scripts/control-kernel/pool.mjs` | P1 | `createKernelPool()` / `resolveKernelConfig()` |
| `scripts/control-kernel/apply-schema.mjs` | P1 | 幂等 apply DDL 的 CLI |
| `scripts/control-kernel/repository.mjs` | P2 | 5 表纯 SQL CRUD + 列名映射 |
| `scripts/control-kernel/lease.mjs` | P2 | lease 仲裁：acquire / heartbeat / release / reap |
| `scripts/control-kernel/kernel.mjs` | P2 | `createKernel()` 组装门面 |
| `scripts/control-kernel/ids.mjs` | P2 | ID 生成规则集中管理 |
| `scripts/control-kernel/cas.mjs` | P7 | 内容寻址存储 |
| `scripts/control-kernel/migrate-from-sqlite.mjs` | P3（可选） | 历史 checkpoint 迁移 |

### StateGraph（1 个）

| 文件 | 阶段 | 职责 |
| --- | --- | --- |
| `scripts/stategraph/postgres-checkpointer.mjs` | P3 | `PostgresCheckpointSaver` |

### Contracts（3 个）

| 文件 | 阶段 |
| --- | --- |
| `contracts/kernel-run.schema.json` | P2 |
| `contracts/kernel-execution.schema.json` | P2 |
| `contracts/kernel-artifact.schema.json` | P2 |

### 测试（10 个）

| 文件 | 阶段 | 重点 |
| --- | --- | --- |
| `tests/helpers/kernel-fixture.mjs` | P1 | 临时 schema + 无 PG 时 skip |
| `tests/control-kernel-schema.test.mjs` | P1 | DDL 幂等、约束生效 |
| `tests/control-kernel-repository.test.mjs` | P2 | CRUD + 级联 + CHECK |
| `tests/control-kernel-lease.test.mjs` | P2 | **并发争抢（最关键）** |
| `tests/control-kernel-events.test.mjs` | P2 | 哈希链 + 篡改检出 |
| `tests/control-kernel-cas.test.mjs` | P7 | 去重、hash、损坏检出 |
| `tests/control-kernel-heartbeat.test.mjs` | P6 | 心跳延长 / 拒绝 |
| `tests/stategraph-postgres-checkpointer.test.mjs` | P3 | 7 方法 + SQLite 等价性 |
| `tests/stategraph-kernel-integration.test.mjs` | P5 | 节点双写 + lease 过期重试 |
| `tests/stategraph-parallel-interface.test.mjs` | P9 | 直通节点 + 开关 |

### 其他（1 个）

| 文件 | 阶段 |
| --- | --- |
| `.env.example`（若不存在） | P1 |

---

## 2. 删除（6 项）

| 路径 | 阶段 | 理由 |
| --- | --- | --- |
| `scripts/stategraph/webchat-bridge.mjs` | P0 | 已被 `manager-request-queue.mjs` 取代 |
| `scripts/stategraph/sqlite-checkpointer.mjs` | P3 | 被 `postgres-checkpointer.mjs` 取代 |
| `scripts/stategraph/database.mjs` | P3 | `openStateGraphDatabase()` 被 `createKernelPool()` 取代 |
| `scripts/control-core/` | P10 | 空目录，旧三层架构遗留 |
| `scripts/monitor-core/` | P10 | 空目录，同上 |
| `scripts/orchestrator/` | P10 | 空目录，同上 |

---

## 3. 归档（移动，不删）

| 源 | 目标 | 阶段 |
| --- | --- | --- |
| `runtime/control/control.db*` | `runtime/archive/` | P10 |
| `runtime/stategraph/checkpoints.db*` | `runtime/archive/` | P10 |

---

## 4. 修改文件（核心 15 个）

| 文件 | 现行行数 | 阶段 | 改动量 | 主要改动 |
| --- | --- | --- | --- | --- |
| `package.json` | — | P1, P10 | 小 | +`pg` 依赖，+3 个 script |
| `scripts/stategraph/runtime.mjs` | 111 | P4 | 中 → ~150 | 注入 kernel + pool；`list()` 走 Kernel；`audit()` 合并双链；`close()` 改 async |
| `scripts/stategraph/graph.mjs` | 583 | P5, P7, P9 | **大 → ~720** | 8 节点双写 Kernel；lease 争抢；LEASE_EXPIRED 分支；putArtifact；split/merge 节点 |
| `scripts/stategraph/state.mjs` | 40 | P5 | 小 → 44 | +`runId` / `taskGroups` / `parallelism` |
| `scripts/stategraph/dispatcher.mjs` | 219 | P6 | 中 → ~260 | `start()` 收 execution；launcher 追加 execution 字段 |
| `scripts/stategraph/agent-runner.mjs` | 147 | P6 | 中 → ~200 | 心跳循环；lease 回收即自杀；releaseLease |
| `scripts/stategraph/output-ingestion.mjs` | 254 | P7 | 小 | 返回值 +`cas` |
| `scripts/stategraph/policy.mjs` | 171 | P5 | 小 | +3 字段校验，含 `lease > heartbeat*2` 断言 |
| `scripts/workflow.mjs` | — | P4 | 小 | `--pg-url`；`kernel-status` 子命令 |
| `config/stategraph-policy.json` | 48 | P5 | 小 | +`lease_seconds` / `heartbeat_interval_seconds` / `parallelism` |
| `contracts/route-plan.schema.json` | — | P9 | 小 | step +`split_hint` |
| `monitor/config.mjs` | 79 | P8 | 小 → ~90 | `databasePath` → `pgUrl` |
| `monitor/server.mjs` | 338 | P8 | 中 → ~400 | 双源合并 + 降级；read model 追加字段 |
| `monitor/main.mjs` | 28 | P8 | 小 | 建 pool/kernel；PG 失败不退出 |
| `agents/manager-agent/workspace/AGENTS.md` | — | P5 | 小 | ⚠️ 推荐阶段顺序 |

## 5. 修改测试（8 个）

| 文件 | 阶段 | 改动 |
| --- | --- | --- |
| `tests/stategraph-runtime.test.mjs` | P4, P5 | 改传 `pool`/`kernel`；断言 Kernel 行 |
| `tests/stategraph-dispatcher.test.mjs` | P5, P6 | `start()` 加 `{ execution }` |
| `tests/stategraph-trust-boundary.test.mjs` | P5 | Kernel 写入过 capability 校验 |
| `tests/stategraph-sandbox.test.mjs` | P5 | attestation 落 `executions` |
| `tests/stategraph-output-boundary.test.mjs` | P7 | 断言 `cas` 字段 |
| `tests/monitor-http.test.mjs` | P8 | 19 端点 + 字段冻结 + **降级用例** |
| `tests/monitor-static-dashboard.test.mjs` | P8 | 5 个静态入口 200 |
| `tests/monitor-sse.test.mjs` | P8 | SSE 首帧格式不变 |
| `tests/monitor-performance.test.mjs` | P8 | 加 Kernel 后仍在预算内 |

---

## 6. 明确不动（保留清单）

```text
# StateGraph 侧
scripts/stategraph/authority.mjs             双 capability 授权
scripts/stategraph/events.mjs                哈希链（被 kernel 复用，不改）
scripts/stategraph/git-worktree.mjs          含 pathKey() Windows 修复 ★
scripts/stategraph/context-manifest.mjs      上下文清单
scripts/stategraph/sandbox-runtime.mjs       Docker 沙箱（531 行）
scripts/stategraph/manager-request-queue.mjs Manager 文件队列
scripts/stategraph/ephemeral-schema.mjs      一次性 Schema 注入
scripts/stategraph/manager-context.mjs       上下文压缩
scripts/stategraph/workflow-lock.mjs         单写锁
scripts/stategraph/process-utils.mjs
scripts/runtime-core/*                       原子写 + JSON ingestion

# Monitor 侧
monitor/telemetry-repository.mjs             继续用 SQLite ★
monitor/event-hub.mjs
monitor/session-tailer.mjs
monitor/session-catalog.mjs
monitor/session-parser.mjs
monitor/artifact-watcher.mjs
monitor/health-classifier.mjs
monitor/redactor.mjs
monitor/workflow-continuation.mjs
monitor/ui/*                                 UI 零改动 ★

# 其他
contracts/ 原有 22 个 schema
agents/ 除 manager-agent/workspace/AGENTS.md 之外全部
extensions/stategraph-webchat/*
```

★ = 用户硬要求或关键修复，绝不能动。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| PG 不可达导致系统整体不可用 | 高 | Monitor 有降级路径（P8）；`workflow.mjs` 明确报 `KERNEL_PG_UNREACHABLE` 并提示检查 `OPENCLAW_PG_URL` |
| 双写不一致（Kernel 有、checkpoint 无） | 中 | 写入顺序固定 Kernel 先；`reconcile` 能从 Kernel 补投影；`kernel-status` 检测不一致 |
| `threadIds()` 改 async 漏改调用点 | 中 | 全仓 `grep -rn "threadIds"` 逐个确认；上游调用早已是 async，实际影响仅 2 行 |
| **Monitor 契约被无意破坏** | **高**（用户硬要求） | P8 测试逐字段断言原有字段名；只允许追加不允许删改；浏览器人工确认 |
| lease 时长设置不当导致误杀正常 Agent | 中 | `policy.mjs` 断言 `lease_seconds > heartbeat_interval_seconds * 2`；默认 120s / 20s |
| 长任务（900s 超时）心跳中断被误判 | 中 | 心跳独立于 Agent 主循环（`setInterval`，不阻塞）；PG 抖动单次失败容忍 |
| 测试污染开发库 | 中 | 每测试文件独立临时 schema，`afterEach` DROP CASCADE |
| CI 无 PG 导致 `npm test` 全红 | 中 | fixture 在 `OPENCLAW_PG_URL` 缺失时整体 skip（P1 就做） |
| `graph.mjs` 改动量大引入回归 | 中 | 节点逐个改、逐个跑 `test:stategraph`；Kernel 调用严格放函数体最前 |
| Windows 上 `pg` 原生依赖编译失败 | 低 | `pg` 是纯 JS（`pg-native` 才需编译，不装它） |
| 并行空节点被误触发 | 低 | 两个节点首行就检查 `parallelism.enabled`；P9 测试断言串行 e2e 不经过 |
| checkpoint 表膨胀 | 低 | P10 可选裁剪脚本；Kernel 事件链不受裁剪影响 |

---

## 8. 触发 Agent 同步的阶段

按 `AGENTS.md` 的同步提醒规则，以下阶段的改动落在同步范围内，**交付时必须提醒用户更新已安装 Agent**：

| 阶段 | 触发原因 |
| --- | --- |
| **P5** | 修改 `agents/manager-agent/workspace/AGENTS.md` |
| **P6** | 修改 dispatcher / agent-runner，影响已安装 Agent 行为 |

对应命令：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

完整安全重装（**仅在注册状态或受管理 runtime 损坏时**，需先手动停止 OpenClaw Gateway 并显式确认）：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

其余阶段（P0–P4、P7–P10）不触及 Agent 同步范围，**不要无依据要求用户重装**。

---

## 9. 施工检查清单

按阶段打勾：

- [ ] **P0** 分支建好、webchat-bridge 已删、`npm test` 绿
- [ ] **P1** `pg` 装好、schema apply 成功、无 PG 时 test 也绿
- [ ] **P2** lease 并发测试通过（10 并发恰好 1 成功）
- [ ] **P3** checkpointer 等价性测试通过
- [ ] **P4** `kernel-status` 可运行、bootstrap 后 `kernel.runs` 有行
- [ ] **P5** e2e 跑到审批点、task/execution 行齐全、`AGENTS.md` 已改 ⚠️
- [ ] **P6** 观察到 `heartbeat_at` 周期前进 ⚠️
- [ ] **P7** `runtime/cas/` 有内容、`kernel.artifacts` 有行
- [ ] **P8** 19 端点全 200、字段未丢、**PG 停掉后 UI 仍打得开**、浏览器人工确认
- [ ] **P9** 串行行为零变化、两节点已注册
- [ ] **P10** `npm test` 全绿、install dry-run 通过、无残留引用
- [ ] 每阶段一次中文 `git commit`
