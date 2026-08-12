# 多 Agent 软件开发与运维四周任务进度报告

> 报告日期：2026-08-06
>
> 覆盖范围：以 2026-07-29 至 2026-08-06 的 Git 提交、`CHANGELOG.md`、现有测试记录与计划文档为依据。该区间共 69 个提交，最后一个提交在 2026-08-05；8 月 6 日没有新增提交。
>
> 判定原则：只有已提交实现且有相应测试或实机记录的能力才标为“完成”；自动化夹具/E2E 与真实 OpenClaw Gateway 演练分开表述；计划文档不等同于功能已交付。

## 一、执行摘要

项目已完成并明显超出第一周“基础框架”的静态搭建阶段：现有 7 个角色 Agent、Agent package/安装入口、workflow、契约、Gate、审批和审计框架，已从多份可写 JSON 的文件协议，演进为以 SQLite Control Kernel v2 为唯一当前状态源的事务化控制面。

第二周所需的可信最小闭环也已在代码和自动化测试层大部分具备：Manager 可通过 workflow/task/run/dispatch/result 边界组织任务，Requirement、Architect、Developer 等角色的职责与结构化产物契约已定义，输入上下文、规则快照、依赖、路径、Agent policy 与输出 Schema 均可在关键边界校验。当前不足是尚未以重装后的真实 OpenClaw Gateway 新建一条完整业务 workflow，连续实际调用全部工作 Agent 并产出一个新的小型程序交付证据。

第三周的“质量闭环”已提前完成较多控制基础，包括测试/发布角色、review-release 血缘、质量 Gate、任务结果验收、失败关闭、重试、恢复、审计和报告模板；但未完成真实的“需求 → 设计 → 开发 → 测试 → 发布”全链路实机演练，因此不能宣称已经具备稳定的软件交付能力。

第四周的自动上线和自主运维尚未开始实施。已有轻量可观测平台与 Manager 编排整改计划，但它们是设计/待办，不是已上线的运维 Agent、监控、部署或回滚系统。当前系统定位仍是本机单节点的多 Agent 研发协作控制面，不应承诺无人值守地自动发布到生产。

## 二、总体状态总览

| 周次 | 目标状态 | 当前判定 | 主要依据 |
|---|---|---|---|
| 第一周：基础运行框架 | 完成并加固 | **完成** | 7 Agent、安装/注册、workflow、Runtime Guard、Schema、事件/Gate/审批、v2 状态机与审计均已提交。 |
| 第二周：需求/架构/开发协作 | 代码闭环基本完成，实机待验 | **部分完成** | task/run/dispatch/result 与上下文/审批机制已实现；真实 Gateway 的新业务 workflow 和真实小程序交付证据未补齐。 |
| 第三周：测试、发布、质量闭环 | 控制基础完成，真实闭环待验 | **部分完成** | Gate、结果验收、test/release 角色、E2E/恢复测试已具备；尚无真实多 Agent 完整交付演练。 |
| 第四周：运维闭环与自动上线 | 仅有设计和前置能力 | **未开始实施** | 有可观测性和编排整改计划；没有运维 Agent、生产部署、在线监控或回滚的实现/验收证据。 |

## 三、第一周：多 Agent 基础运行框架

### 目标完成情况

| 任务清单 | 状态 | 已完成内容 | 仍需注意 |
|---|---|---|---|
| 项目初始化 | 完成 | 已建立项目目录、配置、Agent package manifest、PowerShell/Bash 安装与校验入口；8 月 5 日重装并同步了 7 个受管理 Agent/runtime。 | 每次安装或源码规则改变后，应使用 runtime bundle 校验安装副本与源码一致。 |
| Agent 注册接口 | 完成 | 7 个固定职责 Agent 已由 package manifest 管理；生成 Agent 可通过 catalog/package 路径接入。 | 新增 Agent 仍需在 allowlist、contract、bundle 与安装验证中同步登记。 |
| workflow 设计 | 完成 | 已定义需求、架构、开发、审查、测试、发布交接等 SDLC 阶段，以及 HOLD、审批、失败、完成和隔离路径。 | 标准 SDLC 与轻量原型的 Intake 分流尚未代码化。 |
| 任务状态机 | 完成并重构 | 早期文件化状态机已由 Runtime Guard 约束；v2 使用 `phase + condition + outcome`、命令式 reducer、CAS、resume 信息和不可变事件。 | 真实 Agent 运行中断后的恢复需要 Gateway 实机演练。 |
| Agent 角色划分 | 完成 | 已明确并保留 Manager、Requirement、Architect、Developer、Review、Test、Release 七类角色。 | 角色边界需在真实全链路调用中验证，避免 Manager 旁路执行。 |
| Agent 通信 | 完成并加强 | task、result、workflow、event、Gate、approval、dispatch 等 JSON/JSONL 契约已定义；声明式 `structured_outputs[]` 纳入完成校验。 | 真实模型输出仍可能失败，必须持续统计重试、截断与最终失败率。 |
| 日志与思维过程追踪 | 完成 | 保留不可变哈希事件、task/dispatch/run/outbox、原始 JSON 失败包、Guard 报告、投影及 audit；不把模型私有推理当作日志保存。 | 还缺真实 Gateway receipt 和真实中断恢复的外部证据。 |
| Pipeline 与人工审批 | 完成核心机制 | Gate fail-closed、当前 candidate 权威、审批作用域、审批评估和架构变更门禁均已落地。 | 仍要实现不可绕过的统一派发入口，防止 prompt 或直接 spawn 旁路。 |

### 第一周关键成果

1. **可信运行时边界。** 7 月 29 日引入 Runtime Guard、版本化状态机、Gate/审批/事件契约，并补齐当前 release Gate 权威、review/release 血缘和锁/证据绑定，避免历史 Gate 或普通文本误放行。
2. **状态一致性由“检查多个文件”升级为“单一事务权威”。** 8 月 5 日 P1–P5 将 v2 workflow/task/run/dispatch/result 收束到 SQLite Control Kernel；成功命令、revision、哈希事件、幂等结果和 projection outbox 同事务提交，JSON/JSONL 仅作为可重建投影。
3. **可恢复与可审计。** active workflow 由数据库 view 派生；投影可删除重建；审计覆盖 SQLite integrity、哈希事件链、任务、run、dispatch、outbox 和 active view；旧 v1 workflow 采用取证归档与 `QUARANTINED` tombstone，而不伪造缺失历史。

### 第一周遗留项

- `test-agent` 仍是 `UNSANDBOXED_LOCAL`，没有真正隔离的执行环境。
- 最新审计已发现 Manager 仍可能跳过 workflow/task/run、context package、审批或派发步骤；这一问题已有整改计划，但尚无对应实现提交。
- 思维过程的追踪应继续以“可验证操作、输入摘要、工具日志、事件和产物”为主，不记录或依赖不可验证的内部推理文本。

## 四、第二周：需求、架构、开发与部分协作

| 任务清单 | 状态 | 已完成内容 | 未完成内容与下一步 |
|---|---|---|---|
| 任务分配 | 部分完成 | Control Kernel 已提供 task 注册、校验、查询、dispatch prepare/receipt/outbox 与 result ingest；派发前校验上下文身份、输入哈希、依赖、路径、Agent policy 和结构化输出声明。 | 真实 `sessions_spawn` 仍需收束为不可绕过的统一编排 API，并补 `agentId` 预检、计划持久化回执和实机演练。 |
| Requirement → Architect | 机制完成，实机待验 | Requirement/Architect 角色、审批评估、架构变更 Gate、上下文与规则快照、HOLD/恢复机制均已具备。 | 尚未提交一条新的真实需求到架构业务 workflow 作为验收样本。 |
| Developer 简单功能开发 | 基础样例存在，v2 待验 | 第一周 Demo 已有本地 branch/worktree/commit；v2 task 验证能约束 worktree、输入和结构化结果。 | 需要新建受控小程序任务，让 Developer 在 v2 工作流中实际提交代码，再由后续 Agent 验收。 |
| 上下文管理 | 基本完成 | Manager 有 context identity、规则快照、input hash、task package、文件化恢复和会话软预算；模型通过配置按 Agent 静态选择。 | 尚未完成按 run 记录 token/cost 的完整台账；需防止 Manager 直接携带过量历史。 |
| 审批机制 | 核心完成 | approval request/response、审批评估、风险 Gate、HOLD、恢复与作用域绑定已实现。 | 应在统一 dispatch 状态机中强制执行，覆盖大架构变更和大范围代码修改的真实场景。 |

### 第二周交付成熟度

第二周的“系统能自动根据用户需求，实现小型程序在本地的开发，并指导使用”应评定为 **已具备实现基础、尚未完成本周期实机验收**。原因是：自动化 v2 E2E 可达到 `READY_FOR_OPERATIONS_HANDOFF`，但该证据主要来自控制层夹具和测试；目前没有证据显示已使用同步后的真实 Gateway，重新走完 Requirement、Architect、Developer、Review、Test、Release 的新业务闭环。

因此，下周应以一个小而完整的本地需求作为验收用例，而不是继续扩展功能：创建 workflow/task/run，真实派发，保留每次 receipt、产物、Git commit、Gate 和最终 audit；再在执行中中断一次 Manager 或 Gateway，验证按 PENDING intent 查询并恢复。

## 五、第三周：测试、发布、质量门禁与报告

| 任务清单 | 状态 | 已具备基础 | 缺口 |
|---|---|---|---|
| 测试流程 | 部分完成 | `test-agent` 角色已存在；任务输出契约、结果摄取、失败关闭、测试记录/报告契约和自动化测试均已具备。 | 未在新 v2 实机 workflow 中证明 Test Agent 生成、执行、分析并报告真实项目测试。 |
| 发布流程 | 部分完成 | `release-agent`、release decision、当前 candidate Gate、review/release 血缘与发布交接路径已定义。 | 没有真实发布或受控发布演练；发布能力仅限运维前 handoff。 |
| 多 Agent 闭环 | 自动化层完成，实机未完成 | 完整 v2 阶段路径、task/dispatch/result 闭环、重启/投影恢复和 exactly-once 测试已提交。 | 未用真实 6 工作 Agent 演练“需求、设计、开发、测试、安全/审查、发布”。 |
| 质量门禁 | 核心完成 | Gate 可 fail-closed；失败测试、缺失审批、结构化产物缺失或错误、路径/身份/哈希不匹配均不能正常完成 task/workflow。 | 必须在真实项目上验证测试失败、未提交变更、审批缺失、安全风险等组合情形。 |
| 报告输出 | 部分完成 | 架构、需求、测试、发布、风险、隔离和失败包的模板/文档已具备；审计可汇总控制面证据。 | 尚未生成一份来自全新实机 workflow 的统一 final report。 |

### 第三周结论

第三周不应标记为“软件交付已完成”。当前完成的是使质量闭环可被控制和验证的基础设施：只有通过可信 session、结构化产物、Gate 和审计的结果才能完成；失败流程会 HOLD、FAIL 或 QUARANTINED。下一步必须把这些规则用于一个真实项目，并由 Test/Review/Release Agent 留下可复核报告。

## 六、第四周：运维闭环、上线与持久化管理

| 任务清单 | 状态 | 当前情况 | 结论 |
|---|---|---|---|
| 运维 Agent | 未开始 | 没有已提交的运维 Agent 实现、生产凭证边界或线上监控接入。 | 不应承诺自主监控、异常定位或自动回滚。 |
| 全流程联调 | 未开始实机演练 | Control Kernel 自动化 E2E 已覆盖状态路径和恢复；真实 Gateway 多 Agent 业务演练尚未完成。 | 先完成本机真实闭环，再讨论上线。 |
| 稳定性优化 | 部分完成 | 已有 CAS、幂等、outbox、崩溃恢复、投影恢复、会话预算、JSON 分类重试与 49,152 输出上限。 | 计划持久化、Intake、Agent 身份、Windows 文件锁/编码和真实外部副作用恢复仍待整改。 |
| 文档整理 | 部分完成 | README、架构、状态恢复、Control Kernel、合同、变更记录、周报和多个计划文档已更新。 | 真实交付跑通后，需要以实际步骤更新使用说明和故障手册。 |
| 扩展性增强 | 基础完成 | package manifest、contract set、版本化状态机、Agent 策略、投影/outbox 为新增角色和流程扩展提供基础。 | 面向用户的流程/审批/发布策略配置尚未形成经过验证的产品能力。 |

### 第四周不能提前承诺的能力

截至本报告日，项目没有生产部署、监控告警、生产数据迁移、远程 Git、在线回滚、多主机分布式控制或真实 sandbox 的验收证据。SQLite 的设计定位是本机单节点多 Agent 协作；未来即使接入 LangGraph/StateGraph 或运维平台，也必须以 Control Kernel 为状态权威，不能重新引入第二套可写状态。

## 七、核心风险与下一步优先级

### 当前最高风险

1. **实机证据不足。** 自动化测试证明控制机制，但不能替代真实 Agent、真实 Gateway、真实项目和外部 session 的行为。
2. **Manager 编排旁路。** 最新整改计划已列出 `agentId` 缺失、直接 spawn、跳过 context/approval/task package、未建立 workflow/task/run 即执行等风险；截至 8 月 6 日仍待实现。
3. **测试隔离缺失。** `UNSANDBOXED_LOCAL` 不适合作为长期默认；不可信测试、依赖安装和联网命令的风险仍需人工控制。
4. **JSON 与 Windows 运行边界。** JSON 解析/Schema/重试已大幅加强，但统一原子 JSON 写入、PowerShell 参数编码、Puppeteer 文件锁与中断恢复尚未按最新计划收口。

### 建议的执行顺序

1. 原 `docs/plan/2026-08-05-manager-orchestration-hardening.md` 已作为历史计划归档；当前实现和后续验收以 `docs/manager-orchestration.md`、`docs/control-kernel-v2.md` 为准。
2. 用一个受控小程序完成新的真实 v2 workflow：Requirement → Architect → Developer → Review → Test → Release，保存 commit、receipt、产物、Gate、audit 和 final report。
3. 在该真实 workflow 中注入一次 Manager/Gateway 中断，验证按 PENDING dispatch intent 查询 session 后恢复，验证状态机设计而不是仅验证夹具。
4. 为 Test Agent 建立受限 runner/sandbox；在此之前，以审批和 Gate 严格限制联网、安装依赖和破坏性命令。
5. 在真实闭环稳定后，再实现只读 Control Kernel/outbox 状态视图和轻量观测，最后才评估受控部署、监控和回滚。

## 八、验证证据

- Git 历史：2026-07-29 至 2026-08-06 共 69 个提交；P0–P5 分别在 2026-08-05 提交。
- `CHANGELOG.md`：记录 P0–P5 的改动、原因、效果与验证；其中 P5 记录 Control Kernel 20 项测试，以及 Runtime Guard 105 项通过、Agent JSON 12 项通过、runtime bundle、迁移和安装测试通过的历史结果。
- `scripts/control-kernel.mjs`、`scripts/control-core/` 与 `tests/control-kernel*.test.mjs`：事务、状态迁移、投影、审计、并发、崩溃和恢复实现/测试。
- `scripts/runtime-guard.mjs`、`scripts/agent-json-harness/`、`scripts/runtime-core/json-ingestion.mjs`：Guard、真实 LLM JSON Harness、保守清洗、重试和失败证据。
- `docs/archive/legacy/plan/2026-08-05-manager-orchestration-hardening.md`：历史 Manager 编排、原子 JSON 与 Windows 恢复计划。

## 九、最终判断

项目已经从“可展示的多 Agent 框架”进入“控制面可信、但业务实机闭环尚待验收”的阶段。第一周目标已经完成并被显著加固；第二、三周的多数代码基础也已提前完成。真正决定项目能否进入第三、四周的，不是继续增加 Agent 或写更多计划，而是完成一次可复核的真实全链路小程序交付、一次中断恢复演练，以及对派发旁路和测试隔离的收口。
