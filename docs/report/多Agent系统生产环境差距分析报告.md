# 多 Agent 系统生产环境差距分析报告

> 报告日期：2026-07-30  
> 评估对象：OpenClaw 多 Agent 软件开发系统  
> 系统定位：面向个人/小团队/中小型软件项目的自动化研发协作平台  
> 评估口径：以当前仓库文档、Agent package、OpenClaw 运行配置、Runtime Guard 设计和既有周计划为准。

## 0. 报告结构

为避免单篇报告变成长篇流水账，本次按“总入口 + 三份专题报告”落地：

| 文件 | 回答的问题 | 说明 |
|---|---|---|
| `docs/report/多Agent系统生产环境差距分析报告.md` | 总结结论、评分和导航 | 当前文件 |
| `docs/report/multi-agent-production-gap-analysis.md` | 现在有什么问题 | 覆盖角色划分、流程、能力真实性、通信、上下文、成本和 developer-agent 能力 |
| `docs/report/architecture-review.md` | 应该怎么改 | 给出适合单服务器、小团队的最终架构 |
| `docs/report/improvement-roadmap.md` | 四周内怎么推进 | 在原计划基础上调整第二、三、四周任务 |

## 1. 总体结论

当前系统的方向是合理的：它没有试图直接替代大型企业研发平台，而是把真实软件开发流程拆成 requirement、architect、developer、review、test、release 等角色，并用 manager-agent 做统一编排。这种拆分适合作为“可审计的自动化研发流水线”的原型。

但它距离真实生产环境还有明显差距。核心问题不是“Agent 数量不够”，而是以下四类能力还不够强：

1. **确定性控制不足**：编译、测试、安全扫描、Git 校验、构建、发布判定不能依赖 LLM 自述，必须由工具和规则引擎给出证据。
2. **上下文成本偏高**：manager-agent 冷启动简单对话已有约 21.7k tokens；如果每个阶段都让大模型读取完整上下文，中小项目一次交付可能达到数百万 tokens。
3. **安全与隔离不足**：当前测试明确是 `UNSANDBOXED_LOCAL`，适合本地可信 demo，不适合执行不可信项目代码。
4. **生产闭环尚未完成**：当前范围主要到“运维前交付”，真实部署、监控、告警、回滚、凭证治理、CI/CD 接入仍应作为后续能力。

特别需要澄清的是：用户定位里提到“OpenClaw + LangGraph”，但当前仓库事实显示，已落地的运行方式主要是 **OpenClaw 原生 Agent + 文件协议 + Runtime Guard**；`LangGraph` 更像后续可接入的 workflow engine。报告建议不要推倒现有实现，而是在第三周或第四周把 LangGraph 作为显式状态流转层接入，保留现有 package manifest、JSON Schema、Runtime Guard 和本地 Git worktree 边界。

## 2. 对关键问题的直接回答

### 2.1 当前 Agent 划分是否合理？

总体合理，但对个人/小团队来说偏重。当前 7 个角色中，manager、developer、test、review 是最必要的；requirement 和 architect 在小项目里可以合并成 product-design 阶段；release-agent 当前更适合作为“发布前检查与交接 Agent”，不应被理解为真实生产部署 Agent。

缺失角色方面，不建议立即新增一堆常驻 Agent。更合理的是：

- `security-agent`：短期并入 review/quality-agent，以工具扫描和规则为主；涉及认证、支付、隐私、供应链时再独立。
- `devops-agent`：第四周引入为 release-ops 能力，先做部署前检查、运行脚本、健康检查和回滚建议，不直接拥有生产权限。
- `database-agent`：按需能力，不常驻；有迁移、索引、数据兼容问题时启用。
- `documentation-agent`：小团队可并入 requirement/release 输出，不必常驻。
- `product-agent`：建议把 requirement-agent 升级为 product-requirement-agent，负责价值、范围、验收标准和用户澄清。

### 2.2 当前工作流是否符合真实开发流程？

线性流程“需求 → 架构 → 开发 → 审查 → 测试 → 发布”符合软件开发的主干，但真实生产流程不是单向瀑布。至少要保留这些回路：

- 需求澄清循环：需求不明确时回到用户或 product-requirement。
- 架构反推需求：架构阶段发现范围、成本、风险冲突时，回到需求或人工审批。
- Review/Test 重做循环：review 或 test 失败后回到 developer，必要时回到 architect。
- Release 否决/暂停：release-agent 可以给 `NO_GO` / `HOLD`，最终推进权应由 manager 的 Gate + 人工审批共同控制。

多 Agent 系统不一定要照搬人类团队流程。Agent 流程可以更短、更机械、更证据化；但不能省略需求边界、实现证据、测试执行、评审、风险披露和人工审批这些生产不变量。

### 2.3 是否过度依赖 LLM？

当前最大的生产风险之一就是容易把 LLM 当成“会做所有事的人”。真实生产环境里，LLM 适合做需求理解、方案生成、代码修改、审查解释、测试设计、报告总结；不适合独自裁定编译是否通过、测试是否通过、安全是否通过、Git 是否干净、构建产物是否可用、部署是否成功。

建议分工：

- **LLM Agent**：理解、规划、生成、解释、归因、报告。
- **Tool**：编译、测试、静态扫描、依赖审计、Git、Docker/容器、构建、部署命令。
- **Rule Engine / Runtime Guard**：状态迁移、Schema 校验、Gate 聚合、审批阻断、权限边界、证据完整性。

### 2.4 Agent 通信方式是否合理？

“Agent 输出 JSON，另一个 Agent 接收 JSON”的方向是对的，但不应让所有内容都变成 JSON。生产环境应采用：

- 机器边界：强制 JSON Schema / JSONL，必须版本化。
- 人类报告：Markdown，便于审阅和归档。
- 大型上下文：文件引用、diff、artifact manifest、RAG 索引，不直接塞进 prompt。
- 错误处理：非法 JSON 只允许一次 JSON-only retry；仍失败则 `BLOCKED` 或 `HOLD`。

在单服务器场景，不需要立即上 Kafka、RabbitMQ 或完整 API Gateway。当前 OpenClaw 会话工具 + 文件化 artifact + Runtime Guard 已足够支撑第二、三周目标。若引入 LangGraph，应把它作为 workflow engine，不要让它绕过 Schema、证据和审批规则。

### 2.5 是否存在 Token 浪费？

存在。已观察到 manager-agent 首次简单对话冷启动约 `21.7k tokens`。这说明角色规则、工具说明、skills 和 workspace 上下文已经有明显固定成本。若 developer/review/test 每次都读取完整需求、完整架构、完整代码和完整历史，成本会迅速放大。

优化方向：

- manager 不保存完整聊天历史给 worker，只传任务上下文包。
- developer 只拿相关需求、相关架构、目标文件、diff 和验收标准。
- review 以 candidate diff、关键文件和检查清单为主，不读取全仓库。
- test 以测试策略、变更文件、项目 test config、AC 覆盖表为主。
- 每阶段生成 `context-summary.md`，旧上下文归档为 evidence，不反复塞进模型。

### 2.6 多 Agent 成本是否可接受？

在当前 LLM-heavy 模式下，一次中小型项目如果包含：

- 需求分析 10 轮
- 架构设计 5 轮
- 开发 50 次调用
- Review 20 次调用
- 测试 30 次调用

仅 worker 调用就是 115 次；加上 manager 调度、Gate、重做和报告，实际可能达到 160-250 次 LLM 调用。

粗略 token 量级：

| 模式 | 估算 token |
|---|---:|
| 未优化、上下文重复传递 | 5M-10M tokens / 项目 |
| 经过 diff/RAG/摘要裁剪 | 2M-4M tokens / 项目 |
| 强工具化、小模型路由后 | 1M-3M tokens / 项目 |

是否可接受取决于模型单价。建议使用公式计算：

```text
项目成本 = input_M * 输入单价 + output_M * 输出单价 + cache_M * 缓存单价
```

更重要的是做模型路由：小模型处理 JSON 修复、摘要、日志归类、简单测试解释；大模型只处理架构决策、复杂实现、疑难 bug 和最终风险判断。

### 2.7 Developer-Agent 是否符合真实开发？

“根据需求生成代码”只是 developer-agent 的一小部分。真实 developer-agent 必须具备工程化执行能力：

- 自动创建任务分支和 worktree。
- 按范围修改代码，不越权。
- 执行格式化、类型检查、测试或构建命令。
- 生成真实 commit，并写入 Workflow/Task/Run/Agent 等 trailer。
- 管理依赖和 lockfile。
- 遇到 merge conflict 不猜测，返回 rework 或人工审批。
- 未来可创建 PR，但当前本地 Git 阶段先不强求远程 PR。

当前项目已经设计了本地 Git worktree 和真实 commit，这是正确方向；下一步重点是让 developer-agent 形成“代码修改 + 工具验证 + commit + 可追溯报告”的稳定闭环。

## 3. 适合个人/小团队的最终合理版本

在单服务器、4 核 CPU、4GB 内存、API 调用模型的限制下，推荐从当前 7 个核心角色收敛为 **6 个常驻 Agent + 若干按需能力**：

1. `manager-agent`：唯一入口、状态机、调度、审批、Gate。
2. `product-requirement-agent`：需求澄清、范围、验收标准、用户价值。
3. `design-agent`：架构、接口、数据模型、测试策略。
4. `implementation-agent`：代码实现、分支、commit、依赖。
5. `quality-agent`：review + test + light security，工具优先。
6. `release-ops-agent`：发布前检查、部署前置、运维交接、回滚建议。

按需能力：

- security mode：认证、权限、供应链、隐私、支付等项目启用。
- database mode：迁移、数据兼容、索引优化时启用。
- documentation mode：用户手册、API 文档、README、变更日志时启用。

核心技术栈建议：

- OpenClaw：Agent workspace、会话、工具、渠道入口。
- LangGraph：可选的显式 workflow engine，用于状态节点和回路，不替代 Runtime Guard。
- Node.js Runtime Guard + Ajv：Schema、事件链、Gate、状态一致性。
- SQLite + JSONL：SQLite 做索引和查询，JSONL/artifacts 做审计事实源。
- 本地 Git worktree：隔离开发、测试、重做和候选 commit。
- 容器或最小 sandbox：第三/四周开始用于执行不可信测试。

这个方案比当前 7 Agent 更适合真实使用，因为它减少固定 prompt 成本和角色切换成本，同时保留生产最关键的不变量：需求边界、设计决策、代码实现、质量验证、发布前检查、人工审批和证据链。

## 4. 当前系统评分

| 维度 | 评分 |
|---|---:|
| 架构合理性 | 7/10 |
| 生产可用性 | 5/10 |
| 成本控制 | 4/10 |
| 扩展能力 | 7/10 |
| 安全性 | 4/10 |
| 自动化程度 | 6/10 |

综合判断：当前版本适合学习多 Agent 架构、演示本地小型项目自动开发、做内部研发辅助工具原型；不适合直接商业化交付、不适合执行不可信代码、不适合无人工监督地上线生产系统。

距离商业化的关键差距：

1. 受控执行环境和 sandbox。
2. 稳定的状态恢复与端到端回归演练。
3. 成本治理和模型路由。
4. CI/CD、部署、监控、回滚和凭证治理。
5. 可配置工作流和项目级 policy。
6. 用户体验层：任务进度、审批、失败解释、产物下载和可视化。

下一阶段最高优先级：**先完成“质量闭环可信化”，再做运维闭环。** 也就是把 developer/review/test/release 的输出全部绑定真实命令、真实 commit、真实日志和 Runtime Guard Gate；否则加更多 Agent 只会放大不确定性。

## 5. 参考文件

- `README.md`
- `docs/architecture.md`
- `docs/workflow.md`
- `docs/manager-orchestration.md`
- `docs/agent-contracts.md`
- `docs/gate-checklists.md`
- `docs/context-and-rule-passing.md`
- `docs/current-progress-assessment.md`
- `docs/component-management.md`
- `docs/unsandboxed-test-policy.md`
- `docs/threat-model.md`

