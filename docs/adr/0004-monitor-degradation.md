# ADR 0004 · Monitor 在 Kernel 不可达时降级为 checkpoint 只读

- 状态：已由 [ADR 0005](./0005-single-machine-sqlite.md) 取代
- 日期：2026-08-18
- 相关：`monitor/server.mjs`、`scripts/stategraph/runtime.mjs`、`docs/plan/02-target-architecture.md` §8.3

> 显式降级原则仍保留，但当前 Monitor 只读 SQLite Kernel，不再合并 PostgreSQL 与 checkpoint 双源。

## 背景

重构把 Monitor 的数据源从「单一 checkpoint 投影」改为「Kernel 事实 + checkpoint 决策」双源合并。这引入一个新的失败点：PostgreSQL 不可达时 Monitor 会怎样。用户明确要求保留监测功能与 UI，且 19 个 HTTP 端点与 3 个 read model 的字段名冻结。

## 备选方案

**A. 硬失败** —— Kernel 不可达时 `/api/workflows` 返回 5xx。

**B. 降级只读（选中）** —— 退化为纯 checkpoint 投影，`execution` / `artifacts` 字段为空，健康状态标记 `DEGRADED`。

**C. 缓存兜底** —— 保留上一次成功快照并持续返回。

## 决定

采用方案 B，并在 B 的基础上对「状态源本身也不可达」这一更严重的情况叠加 C 的行为。

具体分层：

| 故障 | 行为 | 健康状态 |
| --- | --- | --- |
| Kernel（`kernel.projectRuns()`）不可达 | 退化为纯 `stateRuntime.list()`；`execution`/`artifacts` 为空 | `DEGRADED`，`kernel_reachable:false` |
| Kernel reaper（`reapExpiredLeases()`）失败 | 记录降级原因，不中断本轮刷新 | `DEGRADED` |
| 状态源（`stateRuntime.list()`）也抛错 | 保留上一次快照，API 仍可响应只读请求 | `DEGRADED` |
| 事件链 audit 检出篡改 | API 仍可达 | `DEGRADED` |

## 理由

**排除 A**：Monitor 是唯一的可观测入口。PG 挂掉恰恰是最需要看仪表盘的时刻，此时让仪表盘也挂掉是最坏的设计。而且 checkpoint 投影里已经包含了 workflow/route/approval/steps 等决策语义——这些信息在 PG 挂掉时依然有价值。

**为什么 telemetry 不迁 PG（与本 ADR 强相关）**：见 ADR 0002。若 telemetry 也在 PG，PG 一挂 Monitor 连自己的健康分类和会话游标都写不了，降级路径根本无法成立。telemetry 留在 SQLite 是降级能力的前提，不是历史遗留。

**为什么 reaper 失败不中断刷新**：`reconcileCycle()` 里 reaper 与 refresh 是两件独立的事。租约回收失败只影响「过期 Agent 何时被标记」，不影响「当前已知状态的展示」。把两者耦合会让一个可延迟的后台任务拖垮实时视图。

**字段追加而非替换**：新增字段全部是追加式——`publicWorkflow` 加 `run_id` / `langgraph_thread_id`，`publicTask` 加 `execution` / `artifacts` / `task_group_id` / `parallel_slot`，快照与 `/api/health` 加 `kernel_reachable`。原有字段名与语义一字不改，UI 不读新字段也不受影响。`protocol_version: 'stategraph-checkpoint-v1'` 与 `source: 'LANGGRAPH_CHECKPOINTS'` 两个常量值冻结——它们标识的是 read model 协议，不是底层存储，改存储不改协议。

**串行下的字段默认值**：`task_group_id` 缺省为 `task_id`，`parallel_slot` 缺省为 `0`。这保证并行开关打开前后 UI 的读取逻辑一致。

## 后果

**正面**：PG 维护窗口期间 UI 仍可用，运维能看到「Kernel 不可达」这个事实本身而不是一个白屏。

**正面**：降级是显式的、可测试的状态，而不是隐式的空数据。`kernel_reachable` 让前端能区分「没有执行记录」和「读不到执行记录」。

**负面**：`refresh()` 需要处理三种数据源组合，复杂度高于单源。已用专门测试覆盖降级路径（要求：停掉 PG 后 UI 必须仍然打得开）。

**约束**：任何后续改动都不得让 Monitor 在 Kernel 不可达时抛出未捕获异常或返回 5xx。这条写进了架构硬约束表第 5、6 条的延伸。
