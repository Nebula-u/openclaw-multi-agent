# ADR 0001 · Control Kernel 用 JavaScript 而非 Python

- 状态：已由 [ADR 0005](./0005-single-machine-sqlite.md) 取代
- 日期：2026-08-18
- 相关：`scripts/control-kernel/*`、`scripts/stategraph/events.mjs`、`docs/plan/06-handoff-status.md` §8

> 本文仅保留历史背景；当前实现不含 StateGraph、PostgreSQL pool 或事件哈希链。

## 背景

Control Kernel 是本次重构新增的唯一可信数据源，负责 run/task/execution/artifact/event 五类事实、lease 仲裁与哈希事件链。项目现有运行时（LangGraph StateGraph、dispatcher、Monitor）全在 Node.js 侧，但团队内部有「数据层用 Python + SQLAlchemy 更顺手」的提议，需要一次性裁决。

## 备选方案

**A. JavaScript（选中）** —— Kernel 与 StateGraph 同进程，直接函数调用，共用 `pg.Pool`。

**B. Python** —— Kernel 独立服务，JS 侧经 HTTP/IPC 调用。

**C. 混合** —— 读路径 Python（分析友好），写路径 JS。

## 决定

采用方案 A：Control Kernel 全部用 JavaScript 实现，不引入 Python。

## 理由

1. **调用点全在 JS 函数体内部**。Kernel 的调用发生在 `graph.dispatch`（抢 lease）、`graph.reconcile`（读 execution）、`dispatcher.start`（写事实）、`agent-runner`（心跳）、`monitor.refresh`（投影）。跨语言就要引入 IPC/HTTP 层，而 `graph.mjs` 每次 invoke 只推进一步，一次完整 workflow 要跨进程往返几十趟。

2. **`canonicalJson` 跨语言做字节级一致极易翻车**。键序、浮点序列化、Unicode 转义任一处不同，两条哈希链就永久对不上。这不是会报错的失败，而是**静默的完整性问题**——审计会说链断了，但你查不出是数据被篡改还是序列化不一致。Kernel 直接 `import { canonicalJson, sha256 } from '../stategraph/events.mjs'` 从根上消除了这类风险。

3. **JS 侧 PG 生态够用**。`pg` 是纯 JS 无编译负担；`@langchain/langgraph-checkpoint-postgres` 官方包存在且接受外部 `Pool`，可与 Kernel 共用连接池。

4. **Kernel 是薄的**。它只有 SQL + 少量哈希计算，没有 ML、数值计算或科学库需求——Python 的优势领域在这里用不上。

5. **Checkpointer 必须留在 JS**（LangGraph.js 运行时在 JS 侧）。Kernel 若去 Python，「Kernel 先写 → Checkpoint 后投影」就跨越了两个进程的事务边界，无法用单一连接保证顺序。

方案 C 被排除的原因是它同时承担 A 与 B 的成本：既要维护跨语言序列化一致性，又要维护两套连接池与部署单元。

## 后果

**正面**：单进程内可用同一个 `pg.Pool` 保证 Kernel 与 Checkpointer 的写入顺序；哈希链算法零漂移风险；部署单元只有 Node + PostgreSQL。

**负面**：若将来要做重数值分析的调度优化，需要单独起分析服务读 PG，而不能复用 Kernel 代码。这被判定为可接受——分析是只读旁路，不参与事务。

**约束**：Kernel 不得重写 `canonicalJson` / `sha256`，必须 import StateGraph 的实现。这条写进了架构硬约束表。
