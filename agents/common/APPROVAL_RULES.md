# APPROVAL_RULES.md — 人工审批规则

> 版本: approval-rules v1
> 审批的发起、记录与放行由 manager-agent 负责；工作 Agent 通过返回 `HUMAN_DECISION_REQUIRED` 触发。

## 1. 必须人工审批的节点

出现以下任一情况，manager-agent 生成 `approval-request.json` 并将工作流置为 `WAITING_HUMAN`：

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
12. 失败测试、UNKNOWN 安全结果或 `UNSANDBOXED_LOCAL` 风险需要例外放行。
13. release-agent 给出 `HOLD`，用户希望继续。
14. 超过最大重做次数（默认 3）。
15. 任何破坏性、不可逆或可能影响其他项目的操作。

## 2. 审批处置硬性规则

- **不设自动超时同意。** 用户沉默 ≠ 批准。
- 等待审批期间，不得继续调度依赖该决策的任务。
- 用户回复后，保存 `approval-response.json` + 原始回复摘要。
- 审批粒度绑定到具体 `decision_id` / `task_id` / `run_id`；一次审批不自动延伸到其他上下文。

## 3. approval-request.json（见 contracts/approval-request.schema.json）

至少含：`decision_id`、`workflow_id`、`task_id`（如适用）、`trigger`（上面 1–15 之一）、`summary`、`options`（每项含 id/描述/影响/可逆性）、`recommended_option`（可选，带理由）、`evidence_refs`、`created_at`、`status`（`PENDING`）。

## 4. approval-response.json（见 contracts/approval-response.schema.json）

至少含：`decision_id`、`workflow_id`、`chosen_option_id` 或 `REJECTED`、`raw_user_reply_summary`、`decided_by`、`decided_at`、`notes`。

## 5. 工作 Agent 侧

工作 Agent 遇到上述节点时**不擅自决定**，返回 `result_status = HUMAN_DECISION_REQUIRED`，在 `decisions_required[]` 列出选项与影响，交由 manager-agent 发起审批。
