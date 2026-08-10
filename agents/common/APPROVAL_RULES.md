# APPROVAL_RULES.md — 人工审批规则

> 版本: approval-rules v1
> 审批的发起、记录与放行由 manager-agent / local-orchestrator 负责；工作 Agent 通过返回 `HUMAN_DECISION_REQUIRED` 触发。
> 新 workflow 只使用 Control Kernel v2：workflow 的待人工状态是 `condition=WAITING_HUMAN`，审批对象自身才使用 `status=PENDING`。历史专用等待名称只存在于归档资料，运行时代码不会产生。

## 1. 必须人工审批的节点

出现以下任一情况，manager-agent 生成审批请求。新 workflow 统一执行 v2 `WAIT_HUMAN`，并将当前业务阶段保留在 `phase` 字段中；需求、架构、发布的“专用等待”只由 `phase + trigger` 展示派生，不写入历史专用等待名称：

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
- request/response 必须同时记录并逐字段匹配 `workflow_id`、可空 `task_id` 和可空 `run_id`；Runtime Guard 校验失败即有效 HOLD。
- `HOLD` 是 workflow / Gate 的合法阻塞状态，不是工作 Agent 的 `result_status`；不得重写历史 `result.json` 为 `HOLD`。保留原 result，由 manager 在控制层记录 `HOLD`、差异和后续人工决策。
- 真实回复必须通过 `approval-resolve` / 等价的受控交互入口提交；它必须绑定相同的 `decision_id`、`workflow_id`、`task_id`、`run_id`，并由 v2 原子执行 `RESOLVE_HUMAN`。存在 `PENDING` request 时，直接 `RESUME` 一律拒绝。

## 3. approval-request.json（见 contracts/approval-request.schema.json）

至少含：`schema_version`、`decision_id`、`workflow_id`、`task_id`（可为 null）、`run_id`（可为 null）、`trigger`（上面 1–15 之一）、`summary`、`options`（每项含 id/描述/影响/可逆性）、`recommended_option`（可为 null，非空时带理由）、`evidence_refs`、`created_at`、`status`（`PENDING`）。

## 4. approval-response.json（见 contracts/approval-response.schema.json）

至少含：`schema_version`、与 request 完全相同的 `decision_id`/`workflow_id`/`task_id`/`run_id`、`outcome`、`chosen_option_id`、`raw_user_reply_summary`、`decided_by`、`decided_at`、`notes`。`APPROVED`/`MODIFIED` 必须选择 request 中存在的 option；`REJECTED` 的 chosen option 必须为 null。

## 5. 工作 Agent 侧

工作 Agent 遇到上述节点时**不擅自决定**，返回 `result_status = HUMAN_DECISION_REQUIRED`，在 `decisions_required[]` 列出选项与影响，交由 manager-agent 发起审批。
