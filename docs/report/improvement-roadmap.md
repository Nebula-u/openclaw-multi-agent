# Improvement Roadmap

> 报告日期：2026-07-30  
> 总周期：四周  
> 当前阶段：第二周  
> 原则：尽量在原计划上调整，不推倒重来。

## 1. 路线总原则

当前系统第一周已完成基础运行框架、Agent 角色、状态机、Schema、日志和审批规则的主体设计。第二周不应急着新增大量 Agent，也不应立刻把系统重写为重型 LangGraph/消息队列平台。

下一步最高优先级是：

```text
先让现有多 Agent 流程可信，再扩大流程范围。
```

可信的含义：

1. 每个 Agent 输出可被 Schema 校验。
2. 每个代码/测试结论有真实 Git、命令和日志证据。
3. Gate 失败会阻断，不被 LLM 文本绕过。
4. manager 只传最小上下文，不复制完整历史。
5. 失败能回到正确阶段。

## 2. 第一周复盘与保留

第一周原目标：

- 项目初始化。
- workflow 设计。
- 任务状态机。
- Agent 角色划分。
- Agent 通信 Schema。
- 日志和过程追踪。
- Pipeline 规则和人工审批。

这些方向都应保留。不要重写为另一套控制平面。当前已有的 package manifest、Runtime Guard、contracts、workspace rules、Git worktree 策略应作为后续三周的地基。

需要修正的口径：

- `LangGraph` 可以作为后续 workflow engine 接入，但当前可信边界仍是 OpenClaw 原生 Agent + 文件协议 + Runtime Guard。
- release 阶段当前只到运维前交付，第四周若做部署必须新增权限、凭证、隔离和审批边界。

## 3. 第二周调整计划

原第二周目标：

- manager 能与用户交互并分配任务。
- Requirement + Architect 完成需求到架构。
- 单 developer-agent 完成简单功能开发。
- manager 管理上下文和规则。
- 接入人工审批。

调整后第二周目标：

```text
完成“需求 → 架构 → 开发”的可信最小闭环，并控制上下文成本。
```

### 3.1 第二周 P0 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| manager 最小工作流闭环 | 一个 demo workflow | 能创建 workflow/task/context，并派发 requirement/architect/developer |
| 上下文裁剪 | `context-summary.md` 和 task context package | worker 不读取 manager 完整聊天历史 |
| Developer Git 闭环 | 本地 branch/worktree/commit | commit 真实存在，diff 在允许范围 |
| Schema 强制校验 | result/task/context/gate 校验日志 | 非法 JSON 会 HOLD，不继续推进 |
| 审批节点 | approval request/response 示例 | 大范围修改、需求歧义可进入 WAITING_HUMAN |

### 3.2 第二周 P1 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| 需求澄清循环 | requirement unanswered questions | 需求不清晰时不直接进入架构 |
| 架构反推需求 | architecture risk/decision | 架构发现需求冲突能回到 requirement |
| 成本记录 | per-run usage log | 每个 LLM 调用记录 input/output/cache |
| 模型路由雏形 | model policy | JSON 修复/摘要可用小模型 |

### 3.3 第二周不建议做

- 不新增完整 devops-agent。
- 不做真实部署。
- 不把 security/database/docs 全部拆成常驻 Agent。
- 不接入重型消息队列。
- 不执行不可信项目测试。

## 4. 第三周调整计划

原第三周目标：

- 测试 agent。
- 发布 agent。
- 多 agent 闭环。
- 质量门禁。
- 报告输出。

调整后第三周目标：

```text
完成“开发 → review → test → rework → release readiness”的质量闭环。
```

### 4.1 第三周 P0 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| review-agent 证据化 | `review-findings.json`、`code-review.md` | finding 绑定 commit/file/line/evidence |
| test-agent 真实执行 | `test-report.md`、`command-records.jsonl` | 测试命令真实执行，stdout/stderr 落盘 |
| failure triage | failure routing table | 测试失败能回到 developer/test/architect |
| TestGate | `gate-result.json` | 失败测试不能 PASS |
| SecurityGate light | secret/dependency/basic scan result | 工具缺失标 UNKNOWN，不当 PASS |
| final report v1 | `final-report.md` | 汇总需求、架构、开发、评审、测试、风险 |

### 4.2 第三周 P1 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| sandbox 方案 PoC | Docker/Podman runner design | 至少证明测试可在受限 worktree 中执行 |
| quality-agent 合并评估 | 配置或文档 | 小团队模式下 review/test/security light 可合并 |
| diff-first review | review context policy | review 默认先读 diff 和相关文件 |
| coverage 规则 | coverage handling doc | 无真实 coverage 工具时标 UNKNOWN |

### 4.3 第三周不建议做

- 不让 release-agent 执行生产部署。
- 不让 test-agent 在无审批下安装依赖或联网。
- 不把 LLM review 结果当作唯一安全结论。

## 5. 第四周调整计划

原第四周目标：

- 运维 agent。
- 全流程联调。
- 稳定性优化。
- 文档整理。
- 扩展性增强。

调整后第四周目标：

```text
完成“运维前交付 + 可选受控部署”的小团队可用版本。
```

### 5.1 第四周 P0 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| release-ops-agent | release/ops workspace 或模式 | 生成 deployment prerequisites、rollback、handoff |
| 受控部署边界 | approval policy | 任何真实部署都需要明确人工审批 |
| 健康检查 | health check command records | 部署后或模拟部署后有真实检查日志 |
| 回滚建议 | rollback-plan.md | 明确回滚步骤、前置条件、风险 |
| 端到端演练 | demo workflow | 从需求到 handoff 可恢复、可审计 |
| 恢复演练 | interruption recovery report | Gateway/manager 中断后能从文件恢复 |

### 5.2 第四周 P1 任务

| 任务 | 交付物 | 验收标准 |
|---|---|---|
| SQLite index | workflow/task/event/cost index | UI/CLI 可快速查询状态 |
| Web/UI 或报告视图 | 简单任务面板 | 用户能看进度、审批、产物 |
| model routing | model policy + usage report | 简单任务走小模型 |
| specialist modes | security/database/docs modes | 按需触发，不常驻消耗 |

### 5.3 第四周不建议做

- 不承诺“全自动无监督上线”。
- 不接触生产凭证，除非完成 SecretRef、审批、审计。
- 不做多租户商业平台。
- 不做复杂 Kubernetes 编排。

## 6. 四周调整后里程碑

| 周次 | 目标 | 成功标志 |
|---|---|---|
| 第一周 | 基础框架 | Agent、Schema、状态机、日志、审批规则存在 |
| 第二周 | 需求/架构/开发可信闭环 | demo 能生成真实 commit，Schema/Gate 能阻断错误 |
| 第三周 | 质量闭环 | review/test/rework/release readiness 有真实证据 |
| 第四周 | 运维前交付与可选部署 | final report、handoff、rollback、恢复演练完成 |

## 7. 推荐优先级清单

### P0：本周必须优先

1. 上下文裁剪和 `context-summary.md`。
2. 所有 worker 输出的 Schema 校验。
3. developer-agent 的真实 Git commit 和验证命令。
4. manager 的 Gate fail-closed。
5. 需求澄清和架构反推需求循环。

### P1：第三周必须完成

1. review finding 证据化。
2. test command record 和 raw logs。
3. failure triage 回路。
4. TestGate/SecurityGate/ReleaseGate 可信聚合。
5. final-report.md。

### P2：第四周增强

1. sandbox 或受限执行环境。
2. release-ops-agent。
3. SQLite 状态索引。
4. 模型路由和成本预算。
5. 简单 UI/报告查看。

## 8. Agent 输出结构建议

后续每次让 Agent 做生产评估时，建议强制输出三个文件：

```text
docs/report/
├── multi-agent-production-gap-analysis.md
├── architecture-review.md
├── improvement-roadmap.md
```

每个文件的职责：

| 文件 | 必答问题 |
|---|---|
| `multi-agent-production-gap-analysis.md` | 现在有什么问题？哪些差距阻碍生产化？ |
| `architecture-review.md` | 应该怎么改？最终架构、Agent 数量、技术栈、部署方式是什么？ |
| `improvement-roadmap.md` | 四周计划怎么调整？当前第二周应该优先做什么？ |

这种结构比单文件流水账更适合迭代：差距、目标架构和路线图可以分别更新。

## 9. 阶段验收标准

### 第二周完成标准

- 能从用户需求创建 workflow。
- requirement、architect、developer 至少完成一次闭环。
- developer 产出真实 commit。
- manager 校验 result/task/context。
- 大范围变更或关键歧义能进入人工审批。
- 记录本次工作流 token/cost 粗账。

### 第三周完成标准

- review-agent 能输出结构化 findings。
- test-agent 能真实执行测试并记录日志。
- 测试失败能回到正确 Agent。
- release-agent 能给出 `GO/NO_GO/HOLD` 且 Gate 可重算。
- 生成统一 final report。

### 第四周完成标准

- 有 release-ops handoff。
- 有 rollback plan。
- 有一次完整端到端演练。
- 有一次中断恢复演练。
- 有 sandbox 或明确替代风险控制方案。
- 有成本预算和模型路由策略。

## 10. 最终判断

当前系统不应在第二周追求“全自动上线”。更现实的目标是：

```text
第二周：可信地生成代码
第三周：可信地验证代码
第四周：可信地交付给运维或受控部署
```

只要这三个阶段跑通，当前系统就能成为个人/小团队可真实使用的自动化研发助手；否则即使新增更多 Agent，也只是把不确定性分散到更多会话里。

