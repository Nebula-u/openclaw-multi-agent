# 多 Agent 软件开发与运维计划：当前完成度评估

> 评估日期：2026-08-03
> 评估口径：以当前分支代码、自动化测试、OpenClaw 实际注册状态、runtime 运行产物与本地 Git 记录为准；平台实现与历史 Demo 的运行状态分开评估，不把仅有设计文档或旧协议产物视为已完全交付。

## 总体结论

按可验证的平台能力估算，项目当前约完成 **72%**；历史 Demo 仍未迁移到当前文件协议，因此不能把它作为端到端闭环已验证的证据。

项目已经具备多 Agent 协作开发小型本地程序的样例能力：7 个 Agent 已注册，且已留下需求、架构、开发、审查、测试与发布候选等产物。本分支补齐了任务控制/产物对应、上下文哈希、审批评估、恢复检查和安装回归；不过，尚未以新协议重新完成一次真实工作流，第四周定义的运维能力也未实现。

### 已验证事实

- OpenClaw 中已实际注册 `manager-agent`、`requirement-agent`、`architect-agent`、`developer-agent`、`review-agent`、`test-agent`、`release-agent` 共 7 个 Agent。
- `openclaw config validate --json` 返回 `valid: true`。
- 已运行过登录聊天 Demo 工作流，目标项目为 `D:\MicroConnect\project\my-chat-app`；本地 Git 中存在开发、审查修复、测试及合并提交。
- 已实现无状态 Node.js Runtime Guard：控制任务/artifact 一一对应、摘要、依赖、重试上限、上下文输入 SHA-256、规则/上下文快照哈希、15 项审批评估和 ArchitectureGate 审批引用均 fail-closed。
- 已新增 `recovery-check`，在单一活动工作流时复用完整 Guard 校验；多个 workflow 时要求用户选择。旧 Demo 的旧版活动索引会返回结构化 schema 诊断并保持 `HOLD`。
- 当前分支 `npm test` 通过：Runtime Guard 78 通过、2 个 Windows 无符号链接权限的测试跳过；离线 LLM harness 8 通过；Bash/PowerShell 安装验证 2 通过。
- 运行产物中存在需求、架构、开发、代码审查、测试和发布候选报告。

### 关键风险

- 控制状态失同步、事件链不完整、结构化结果不可靠、Gate 语义失效这四类问题，已通过 Runtime Guard 的状态机、JSON/JSONL Schema、事件链哈希和 Gate 聚合校验转为 fail-closed；当前验证路径不会再接受这些不一致继续推进。
- 安全门禁仍有项目外部风险需要持续跟踪，例如真实部署、线上监控与生产级回滚并未纳入本轮交付范围。
- 当前范围明确止于“运维前交付”，没有真实部署、监控、告警或线上回滚能力。

状态说明：✅ 已完成并有运行/文件证据；🟡 部分完成或仅完成设计；❌ 未完成。

## 第一周：基础运行框架

| 任务 | 状态 | 评估 |
|---|---|---|
| 项目初始化、目录、配置、OpenClaw 入口 | ✅ | 已有安装、静态校验、配置恢复脚本及完整目录结构；7 个 Agent 已真实注册。 |
| Agent 注册接口 | ✅ | 已迁移为 package manifest 驱动；安装/验证脚本不再维护固定 ID 数组，支持生成 Agent 的审批式构建、注册、激活和安全删除。 |
| SDLC workflow 设计 | ✅ | 已定义需求、架构、开发、审查、测试、发布交接等 13 阶段。 |
| 任务/工作流状态机 | ✅ | 已引入 Runtime Guard、workflow/task 状态机和 `state_revision` 校验；失同步会 fail-closed。 |
| Agent 角色划分 | ✅ | manager、requirement、architect、developer、review、test、release 已落地。 |
| Agent 通信 JSON Schema | ✅ | 20 份契约已通过 Runtime Guard 强制校验，非法 JSON、字段缺失和作用域不匹配会被拒绝。 |
| 日志、思维/过程追踪 | ✅ | 已补齐事件链哈希、append-only 追加、fsync 与篡改检测，事件链不完整会阻断推进。 |
| Pipeline 规则与人工审批 | ✅ | 已实现 Gate 重新聚合、审批 scope 绑定、15 项 trigger assessment、ArchitectureGate 审批引用、Review/Security current-candidate 证据约束和 Release current authority 校验。 |

## 第二周：需求、架构与开发

| 任务 | 状态 | 评估 |
|---|---|---|
| Manager 交互、分派、汇总 | 🟡 | Guard 现已拒绝 orphan artifact、缺失控制任务、依赖异常及缺失 user/manager summary；但历史 Demo 未迁移，且尚未重新演练真实多 Agent 闭环。 |
| 需求到架构 | ✅ | 已产出需求、验收标准、架构、ADR、接口、数据模型和实现计划。 |
| 单开发 Agent 实现小型程序 | ✅ | 已在 `my-chat-app` 生成登录聊天 Demo，并提交到本地 Git。 |
| 上下文管理与规则传递 | 🟡 | Guard 已读取 context manifest、重算输入/规则 SHA-256 并校验 workflow 快照；`recovery-check` 已提供可执行入口，但尚未完成一次真实中断后续跑演练。 |
| 架构/大改动人工审批 | ✅ | intake、任务和架构阶段均有 15 项 trigger assessment；命中项必须绑定批准 decision，ArchitectureGate PASS 必须引用全部命中 decision。 |

## 第三周：测试、发布与质量闭环

| 任务 | 状态 | 评估 |
|---|---|---|
| 测试 Agent、测试报告 | 🟡 | 已有 40 通过、0 失败、1 跳过的 API 测试报告；前端构建测试在测试 worktree 中未执行。 |
| 测试代码审查 | ❌ | 未见独立的“测试代码审查”阶段产物。 |
| 发布 Agent、变更/发布检查 | 🟡 | 已有发布候选 `GO` 和运维交接材料，但不是实际发布。 |
| 多 Agent 闭环、失败重试 | 🟡 | 控制面已对状态、任务、输入、结果、摘要和审批 fail-closed；仍缺一次按新协议完成的真实多 Agent 工作流演练。 |
| 质量门禁 | ✅ | Guard 重算 Gate overall，并对未决审批、阻断 finding、current-candidate 证据与 release task/run authority fail-closed；历史 Demo 的旧 Gate 不作为当前协议通过证据。 |
| 最终综合报告 | ❌ | 有需求、架构、开发、测试、发布报告，但未生成统一的 `final-report.md`。 |

## 第四周：运维闭环

| 任务 | 状态 | 评估 |
|---|---|---|
| 部署、监控、异常定位、回滚 | ❌ | 当前项目明确限定为“运维前交付”，未实现部署、监控、告警或真实回滚。 |
| 全流程端到端联调 | ❌ | 历史能力样例是旧协议且已被安全 HOLD；尚未完成按当前协议的新 Demo 与运维范围联调。 |
| 重试、超时、人工接管、状态恢复 | 🟡 | 最大尝试次数、审批评估和 `recovery-check` 已可执行；尚缺真实中断、换 manager 会话后恢复并完成的演练。 |
| 使用、角色、流程、审批文档 | ✅ | README、Manager 操作规范、审批和恢复文档已同步当前 Guard 行为；运维文档仍受第四周范围限制。 |
| 可配置角色、流程、审批、发布策略 | 🟡 | 已有策略覆盖与模型配置；角色注册和工作流仍主要是固定实现。 |

## 优先级任务清单

### P0：迁移并演练可信控制面

1. 不改写历史证据的前提下，审计旧 Demo 并创建一个符合当前 schema 的新 Demo workflow。
2. 在新 Demo 中验证控制任务、artifact、context manifest、snapshot hash、summary 与 approval assessment 的完整链路。
3. 中断一个已派发任务，由新 manager 会话执行 `recovery-check` 后恢复；保留全过程证据。

### P1：补齐第三周闭环

1. 增加独立测试代码审查阶段。
2. 生成统一 `final-report.md`，汇总架构、开发、测试、审查、发布、风险和未验证项。
3. 演练一次中断恢复：中断某一阶段后由新的 manager 会话运行 `recovery-check`、恢复并完成工作流。
4. 修复或升级已发现的安全问题，至少包括 token 存储策略和登录限速。

### P2：进入第四周运维能力

1. 新增 deployment/operations Agent，明确其权限边界和审批点。
2. 接入目标环境的部署、健康检查、指标采集、告警、异常定位和回滚建议。
3. 将测试从 `UNSANDBOXED_LOCAL` 迁移至受控隔离环境。
4. ✅ 已将固定 7 Agent 安装方案改为 package catalog；后续工作流图扩展仍可在 LangGraph 阶段继续建设。

## 证据位置

- `runtime/control/active-workflows.json`：活动工作流索引。
- `runtime/control/workflows/WF-a15e8562-62b5-4a53-a95e-4dbb50cc1fea/workflow.json`：工作流快照。
- `runtime/control/workflows/WF-a15e8562-62b5-4a53-a95e-4dbb50cc1fea/events.jsonl`：事件链。
- `runtime/artifacts/WF-a15e8562-62b5-4a53-a95e-4dbb50cc1fea/`：各阶段任务产物。
- `README.md`、`docs/workflow.md`、`docs/state-and-recovery.md`：架构边界、工作流和恢复设计。
