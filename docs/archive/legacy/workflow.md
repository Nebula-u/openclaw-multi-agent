# workflow.md — 主流程与状态机

> 权威来源：`config/workflow-state-machine.json`、`contracts/workflow.schema.json`、`contracts/task.schema.json`。
> 文档日期：2026-07-23

## 1. 本文用途

本文说明标准 SDLC 主流程的 **13 个阶段**（每阶段职责与产出），并列出**任务状态机**与**工作流状态机**的**全部枚举值**。状态枚举、合法迁移和阶段—状态约束以 `config/workflow-state-machine.json` 为准，contracts 约束快照字段。主流程由 `manager-agent` 驱动；Runtime Guard 不编排任务，在边界执行 fail-closed 校验，并仅按 manager 的显式调用原子提交关键控制快照。

## 2. 13 阶段主流程

| # | 阶段 | 主要负责 | 职责与产出 |
|---|------|----------|------------|
| 1 | **INTAKE** | manager | 保存用户原始需求（`user-request.md`）；解析目标项目绝对路径；探测 Git 状态、base commit、policy 与隔离模式（`UNSANDBOXED_LOCAL`）；创建 workflow 与 requirement task |
| 2 | **REQUIREMENTS** | requirement | 生成范围/非范围/假设/问题与验收标准（每条 `AC-<n>`）；建立需求追踪关系；manager 校验输出与追踪；关键歧义进入 `WAITING_HUMAN` |
| 3 | **REQUIREMENT GATE** | manager | 按 Requirement Gate 检查清单逐项判定，写 `gates/`；通过才进入下一阶段 |
| 4 | **ARCHITECTURE** | architect | 基于**已批准需求**生成架构、ADR、接口、数据模型、威胁模型、测试策略、开发任务清单；建立"需求—设计—实现—测试"追踪；重大决策进入 `WAITING_HUMAN` |
| 5 | **ARCHITECTURE GATE** | manager | 按 Architecture Gate 检查清单判定 |
| 6 | **DEVELOPMENT** | developer | manager 创建绝对 worktree 与上下文包；developer 实现完整代码并**真实本地 commit**；manager 校验 commit/diff/范围/证据 |
| 7 | **CODE REVIEW** | review | review 在指定候选 commit 上**独立只读**审查；`REQUEST_CHANGES` 时 manager 创建新的 developer rework task/attempt/worktree，重做后**必须重新 review** |
| 8 | **DEVELOPER REWORK**（如需要） | developer | 针对审查/失败的重做；新 attempt + 新 run + 新 worktree；不覆盖旧 run |
| 9 | **TEST IMPLEMENTATION AND EXECUTION** | test | manager 从**已过代码审查**的候选 commit 建 test worktree；test 补充测试并**实际执行**真实命令、提交本地 commit；所有测试记录 `UNSANDBOXED_LOCAL` |
| 10 | **TEST CODE REVIEW** | review | 审查新增测试与测试配置：空断言、永真断言、过度 mock、隐藏失败、不合理 skip |
| 11 | **FAILURE TRIAGE / REWORK**（如需要） | manager 归口 | 按缺陷类型分派（见 §5）；工具/环境缺失 → `BLOCKED` 或 `HOLD`，不假装成功 |
| 12 | **RELEASE-PREPARATION VERIFICATION** | release | 验证最终候选 commit、构建、测试、安全、artifact、回滚与运维交接材料；给出 `GO` / `NO_GO` / `HOLD`；**不执行部署** |
| 13 | **FINAL REPORT / OPERATIONS HANDOFF** | manager | 汇总各 Agent 原始总结；列出最终候选 commit、测试事实、审查发现、安全状态、已知问题、未验证内容与发布前判定；生成运维交接清单，但**不执行运维动作** |

各阶段结束都伴随对应 Gate（详见 `docs/gate-checklists.md`）与 `context-summary.md` 更新。`GO` 仅表示 `READY_FOR_OPERATIONS_HANDOFF`，**不表示已部署或已上线**。

## 3. 任务状态机（`task.status`，全枚举）

来源 `contracts/task.schema.json`：

```text
CREATED · READY · DISPATCHED · RUNNING · WAITING_HUMAN · BLOCKED ·
NEEDS_REWORK · COMPLETED · FAILED · CANCELLED · SUPERSEDED · LOST
```

合法迁移只能采用状态机的 `task.transitions`；下列是关键语义，而非“任意状态可迁移”的简写：

```text
CREATED → READY → DISPATCHED → RUNNING →
    ├─ COMPLETED        （校验 + Gate 通过）
    ├─ NEEDS_REWORK     （校验或审查未过；新 attempt/run）
    ├─ BLOCKED          （环境/工具/权限阻塞）
    ├─ WAITING_HUMAN    （触发人工审批节点）
    └─ FAILED
`WAITING_HUMAN` 只能从 `READY` 或 `RUNNING` 进入，并可回到 `READY`/`RUNNING`，或进入 `BLOCKED`、`CANCELLED`、`SUPERSEDED`。
`BLOCKED` 表示任务受环境、工具或权限阻塞；只能回到 `READY`、转 `WAITING_HUMAN`、`FAILED`、`CANCELLED` 或 `SUPERSEDED`。
`LOST` 只能从 `DISPATCHED` 或 `RUNNING` 进入；之后只能转 `BLOCKED`、`FAILED`、`CANCELLED` 或 `SUPERSEDED`。`SUPERSEDED` 只可由状态机列出的非终态进入，不能以“任意状态”概括。
```

`task_type` 枚举（来源同上）：`REQUIREMENTS`、`ARCHITECTURE`、`DEVELOPMENT`、`CODE_REVIEW`、`DEVELOPER_REWORK`、`TEST_IMPLEMENTATION`、`TEST_CODE_REVIEW`、`FAILURE_TRIAGE`、`RELEASE_VERIFICATION`。
`assigned_agent` 枚举：`requirement-agent`、`architect-agent`、`developer-agent`、`review-agent`、`test-agent`、`release-agent`。

## 4. 工作流状态机（`workflow.status`，全枚举）

来源 `contracts/workflow.schema.json`：

```text
CREATED · ANALYZING_REQUIREMENTS · WAITING_REQUIREMENT_APPROVAL ·
DESIGNING · WAITING_ARCHITECTURE_APPROVAL · IMPLEMENTING ·
REVIEWING_CODE · TESTING · REVIEWING_TESTS ·
VERIFYING_RELEASE_READINESS · WAITING_RELEASE_APPROVAL ·
WAITING_HUMAN · HOLD · READY_FOR_OPERATIONS_HANDOFF · RELEASE_NO_GO · RELEASE_HOLD ·
FAILED · CANCELLED
```

阶段 → 工作流状态的对应（示意）：

```text
INTAKE                         → CREATED
REQUIREMENTS                   → ANALYZING_REQUIREMENTS
REQUIREMENT GATE（待批准）      → WAITING_REQUIREMENT_APPROVAL
ARCHITECTURE                   → DESIGNING
ARCHITECTURE GATE（待批准）     → WAITING_ARCHITECTURE_APPROVAL
DEVELOPMENT                    → IMPLEMENTING
CODE REVIEW                    → REVIEWING_CODE
TEST IMPL & EXECUTION          → TESTING
TEST CODE REVIEW               → REVIEWING_TESTS
RELEASE-PREPARATION VERIFY     → VERIFYING_RELEASE_READINESS
（release HOLD，用户欲继续）    → WAITING_RELEASE_APPROVAL
FINAL REPORT / HANDOFF（GO）    → READY_FOR_OPERATIONS_HANDOFF
release NO_GO                  → RELEASE_NO_GO
release HOLD                   → RELEASE_HOLD
异常终止 / 用户取消             → FAILED / CANCELLED
```

`WAITING_HUMAN` 是等待明确人工决定的 workflow 状态；`HOLD` 是 manager 因一致性、证据或安全边界无法继续而暂停的 workflow 状态。两者都属于 workflow 状态，**不是** Agent `result_status`。`result_status` 的合法值仅为 `COMPLETED`、`NEEDS_REWORK`、`BLOCKED`、`HUMAN_DECISION_REQUIRED`、`FAILED`。`RELEASE_HOLD` 仅适用于发布阶段。

工作流合法迁移、包括 `WAITING_HUMAN`/`HOLD` 的可恢复去向，以及每个 `current_phase` 可搭配的状态，均以状态机的 `workflow.transitions` 与 `workflow.phase_statuses` 为准；manager 不得自行创造迁移。每次接受状态变化时，`state_revision` 必须递增，并与最新 `events.jsonl` 事件、`workflow.json` 和 `active-workflows.json` 的值一致。

## 5. FAILURE TRIAGE 归口（阶段 11）

| 失败类型 | 归口 Agent |
|----------|------------|
| 生产代码缺陷 | `developer-agent` |
| 测试代码错误 | `test-agent` |
| 架构问题 | `architect-agent`，再由 `developer-agent` 实现 |
| 验收标准冲突 | `requirement-agent` + 人工审批 |
| 安全问题 | `developer-agent` 修复，`review-agent` 复审 |
| 工具 / 环境缺失 | `BLOCKED` 或 `HOLD`，不假装成功 |

## 6. 最大重做次数

- 默认最大重做次数为 **3**（可由 policy 修改）。
- 超过最大次数 → 工作流置 `WAITING_HUMAN`（approval trigger `MAX_REWORK_EXCEEDED`），生成 approval-request 等待人工决策；**不设自动超时同意**。

## 7. 相关文档

`manager-orchestration.md`（每阶段的派发与校验算法）、`agent-contracts.md`（各阶段产物）、`state-and-recovery.md`（状态文件与恢复）、`gate-checklists.md`（各 Gate 的检查项）、`human-approval.md`（审批节点）。
