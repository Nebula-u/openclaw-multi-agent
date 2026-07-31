# 多 Agent 软件开发与运维计划：当前完成度评估

> 评估日期：2026-07-27  
> 评估口径：以仓库文件、OpenClaw 实际注册状态、runtime 运行产物与本地 Git 记录为准；不把仅有设计文档的能力视为已完全交付。

## 总体结论

按可验证的实际运行能力估算，项目当前约完成 **65%**。

项目已经具备多 Agent 协作开发小型本地程序的样例能力：7 个 Agent 已注册，且已留下需求、架构、开发、审查、测试与发布候选等产物。不过，它尚未达到“可恢复、可审计、可安全上线”的全自动交付闭环，第四周定义的运维能力基本未实现。

### 已验证事实

- OpenClaw 中已实际注册 `manager-agent`、`requirement-agent`、`architect-agent`、`developer-agent`、`review-agent`、`test-agent`、`release-agent` 共 7 个 Agent。
- `openclaw config validate --json` 返回 `valid: true`。
- 已运行过登录聊天 Demo 工作流，目标项目为 `D:\MicroConnect\project\my-chat-app`；本地 Git 中存在开发、审查修复、测试及合并提交。
- 已实现无状态 Node.js Runtime Guard，并通过 `node --test tests/runtime-guard.test.mjs`、`node --test tests/validate-install.test.mjs`、`node scripts/runtime-guard.mjs self-check --project-root .` 与 `bash scripts/validate-install.sh --skip-openclaw` 验证。
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
| Agent 通信 JSON Schema | ✅ | 12 份契约已通过 Runtime Guard 强制校验，非法 JSON、字段缺失和作用域不匹配会被拒绝。 |
| 日志、思维/过程追踪 | ✅ | 已补齐事件链哈希、append-only 追加、fsync 与篡改检测，事件链不完整会阻断推进。 |
| Pipeline 规则与人工审批 | ✅ | 已实现 Gate 重新聚合、审批 scope 绑定、Review/Security current-candidate 证据约束和 Release current authority 校验。 |

## 第二周：需求、架构与开发

| 任务 | 状态 | 评估 |
|---|---|---|
| Manager 交互、分派、汇总 | 🟡 | Demo 中确实派发了多个 Agent，但控制层未完整记录后续任务。 |
| 需求到架构 | ✅ | 已产出需求、验收标准、架构、ADR、接口、数据模型和实现计划。 |
| 单开发 Agent 实现小型程序 | ✅ | 已在 `my-chat-app` 生成登录聊天 Demo，并提交到本地 Git。 |
| 上下文管理与规则传递 | 🟡 | 每任务有 context/task/rules 输入包；但未验证跨中断恢复的完整性。 |
| 架构/大改动人工审批 | 🟡 | 技术栈和 UI 基线有用户确认；后续大功能变更缺少可追溯审批记录。 |

## 第三周：测试、发布与质量闭环

| 任务 | 状态 | 评估 |
|---|---|---|
| 测试 Agent、测试报告 | 🟡 | 已有 40 通过、0 失败、1 跳过的 API 测试报告；前端构建测试在测试 worktree 中未执行。 |
| 测试代码审查 | ❌ | 未见独立的“测试代码审查”阶段产物。 |
| 发布 Agent、变更/发布检查 | 🟡 | 已有发布候选 `GO` 和运维交接材料，但不是实际发布。 |
| 多 Agent 闭环、失败重试 | 🟡 | 制品链覆盖多个角色，但状态、事件、输入任务和结果不完整，无法证明闭环可靠。 |
| 质量门禁 | ❌ | 设计存在，执行不可信：Gate 中有 `FAIL` 仍总体 `PASS`；审查发现的高风险问题未全部处理。 |
| 最终综合报告 | ❌ | 有需求、架构、开发、测试、发布报告，但未生成统一的 `final-report.md`。 |

## 第四周：运维闭环

| 任务 | 状态 | 评估 |
|---|---|---|
| 部署、监控、异常定位、回滚 | ❌ | 当前项目明确限定为“运维前交付”，未实现部署、监控、告警或真实回滚。 |
| 全流程端到端联调 | ❌ | 跑过能力样例，但控制状态不一致，且未覆盖运维，不能算完整联调。 |
| 重试、超时、人工接管、状态恢复 | 🟡 | 文档规定最大重做次数和人工接管；真实状态不一致说明恢复能力尚未通过验证。 |
| 使用、角色、流程、审批文档 | 🟡 | 文档覆盖较全，但旧交付报告与当前运行产物不一致，且缺少运维文档。 |
| 可配置角色、流程、审批、发布策略 | 🟡 | 已有策略覆盖与模型配置；角色注册和工作流仍主要是固定实现。 |

## 优先级任务清单

### P0：先修复可信控制面

1. 统一 `active-workflows.json`、`workflow.json`、任务状态、事件链和 Git 候选提交。
2. 对 task、result、gate、approval 等所有运行产物执行强制 JSON Schema 校验。
3. 非法 JSON、字段不匹配、缺失事件哈希或状态不一致时，必须自动 `HOLD`，禁止继续派发。
4. 修复 Gate 聚合逻辑：阻断性 `FAIL`、未关闭审批、未处理 HIGH/CRITICAL 风险必须阻断发布。

### P1：补齐第三周闭环

1. 增加独立测试代码审查阶段。
2. 生成统一 `final-report.md`，汇总架构、开发、测试、审查、发布、风险和未验证项。
3. 演练一次中断恢复：中断某一阶段后由新的 manager 会话恢复并完成工作流。
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
