# APPROVAL_RULES.md — 人工审批规则

> 版本: approval-rules v2
> 审批节点由 Orchestrator 根据冻结路线、Gate 和错误升级规则生成；只有绑定原始 Manager Session 的明确用户决定可以写入。

## 1. 必须人工审批的节点

出现以下任一情况，工作 Agent 返回 `HUMAN_DECISION_REQUIRED`；Orchestrator 根据代码策略生成绑定当前 decision、route 和候选 commit 的审批：

1. 需求存在影响范围或验收方式的关键歧义。
2. 实现存在明显不同取舍的方向（成本/风险/兼容性/维护差异大）。
3. 公共 API 或数据格式的不兼容变更。
4. 不可逆迁移、删除或批量重写数据。
5. 需要安装依赖、下载程序、开放网络或修改系统环境。
6. 需要访问凭证、账号或外部服务。
7. 输入目录不是 Git 仓库。
8. 输入仓库存在未提交修改。
9. 需要改变已批准的需求或架构。
10. 第三方代码 / 许可证 / 版权来源不明确。
11. 严重安全问题需要风险接受。
12. 失败测试、UNKNOWN 安全结果，或在 Docker 模式下 sandbox attestation 不完整。
13. release-agent 给出 `HOLD`，用户希望继续。
14. 超过最大重做次数（默认 3）。
15. 任何破坏性、不可逆或可能影响其他项目的操作。

## 2. 审批处置硬性规则

- **不设自动超时同意。** 用户沉默 ≠ 批准。
- 等待审批期间，不得继续调度依赖该决策的任务。
- 审批粒度绑定 `decision_id`、`workflow_id`、`route_hash`，适用时同时绑定 `task_id`、`run_id` 和 `candidate_commit`；一次审批不延伸到其他上下文。
- 路线确认后冻结 steps 与 approval plan；Agent 不得修改、跳过或自行满足审批节点。
- Agent 返回 `HUMAN_DECISION_REQUIRED` 后，人工只能选择由代码声明的选项；未通过 Gate 的结果不能被人工直接改写为完成。
- 真实回复只能由原始 Manager Session 写入 schema-valid `DECISION` request，并由 Orchestrator 校验后写入 Control Kernel。

## 3. approval-request.json（见 contracts/approval-request.schema.json）

至少含：`schema_version`、`decision_id`、`workflow_id`、`task_id`（可为 null）、`run_id`（可为 null）、`trigger`（上面 1–15 之一）、`summary`、`options`（每项含 id/描述/影响/可逆性）、`recommended_option`（可为 null，非空时带理由）、`evidence_refs`、`created_at`、`status`（`PENDING`）。

## 4. approval-response.json（见 contracts/approval-response.schema.json）

至少含：`schema_version`、与 request 完全相同的绑定字段、`outcome`、`chosen_option_id`、`raw_user_reply_summary`、`decided_by`、`decided_at`、`notes`。决定者必须是明确的 `human:*` 身份，选择项必须来自代码生成的 options。

## 5. 工作 Agent 侧

工作 Agent 遇到上述节点时**不擅自决定**，返回 `result_status = HUMAN_DECISION_REQUIRED`，在 `decisions_required[]` 列出事实、选项与影响；后续审批生成和状态推进全部由 Orchestrator 完成。
