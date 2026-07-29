# human-approval.md — 人工审批触发条件与流程

> 版本: human-approval v1
> 权威规则以 `agents/common/APPROVAL_RULES.md`（approval-rules v1）与 `contracts/approval-request.schema.json` / `contracts/approval-response.schema.json` 为准。
> 散文用中文；`trigger`、`status`、`outcome` 等字段值用英文。

## 1. 审批责任分工

- **manager-agent** 是唯一的审批发起、记录与放行方：命中任一触发条件时，它生成 `approval-request.json` 并把工作流置为 `WAITING_HUMAN`。Runtime Guard 只校验审批关联，不发起、不代答也不放行。
- **工作 Agent**（requirement / architect / developer / review / test / release）遇到需要审批的节点时**不擅自决定**，返回 `result_status = HUMAN_DECISION_REQUIRED`，在 `result.json.decisions_required[]` 列出选项、影响与可逆性，交 manager-agent 处理。

## 2. 15 个必须人工审批的触发条件

出现以下**任一**情况即触发审批。每条后括注对应的 `trigger` 枚举值（见 `contracts/approval-request.schema.json`）：

1. 需求存在影响范围或验收方式的**关键歧义**。（`REQUIREMENT_AMBIGUITY`）
2. 实现存在明显不同取舍的方向（成本 / 风险 / 兼容性 / 维护差异大）。（`IMPLEMENTATION_TRADEOFF`）
3. 公共 API 或数据格式的**不兼容变更**。（`PUBLIC_API_BREAKING_CHANGE`）
4. 不可逆迁移、删除或**批量重写数据**。（`IRREVERSIBLE_DATA_OP`）
5. 需要安装依赖、下载程序、开放网络或修改系统环境。（`NEEDS_INSTALL_OR_NETWORK`）
6. 需要访问凭证、账号或外部服务。（`NEEDS_CREDENTIALS`）
7. 输入目录**不是 Git 仓库**（不擅自 `git init`）。（`INPUT_NOT_GIT_REPO`）
8. 输入仓库存在**未提交修改**（不擅自 commit / stash / 丢弃 / reset）。（`INPUT_DIRTY_WORKTREE`）
9. 需要改变**已批准**的需求或架构。（`CHANGE_APPROVED_REQ_OR_ARCH`）
10. 第三方代码 / 许可证 / 版权来源不明确。（`THIRDPARTY_LICENSE_UNCLEAR`）
11. 严重安全问题需要**风险接受**。（`SECURITY_RISK_ACCEPTANCE`）
12. 失败测试、UNKNOWN 安全结果或 `UNSANDBOXED_LOCAL` 风险需要**例外放行**。（`TEST_OR_SECURITY_EXCEPTION`）
13. release-agent 给出 `HOLD`，但用户希望**继续**。（`RELEASE_HOLD_OVERRIDE`）
14. 超过**最大重做次数**（默认 3）。（`MAX_REWORK_EXCEEDED`）
15. 任何**破坏性、不可逆或可能影响其他项目**的操作。（`DESTRUCTIVE_OR_CROSS_PROJECT`）

## 3. 审批处置硬性规则

- **不设自动超时同意。** 用户**沉默 ≠ 批准**；等待可以无限期持续，绝不因超时而默认放行。
- 等待审批期间，**不得**继续调度依赖该决策的任务。
- 用户回复后，保存 `approval-response.json` + 原始回复摘要（`raw_user_reply_summary`）。
- 审批 request/response 必须逐字段绑定到同一 `decision_id` / `workflow_id` / `task_id` / `run_id`；一次审批不得跨 workflow、task 或 run 重用。
- manager-agent **不得**模拟用户审批，不得替用户选择选项。

## 4. approval-request.json 流程

权威 schema：`contracts/approval-request.schema.json`。至少包含字段：

| 字段 | 说明 |
|------|------|
| `decision_id` | 唯一标识，形如 `DEC-...` |
| `workflow_id` | 归属 workflow，形如 `WF-...` |
| `task_id` | 归属 task（如适用），形如 `TASK-...` |
| `run_id` | 归属 run（如适用），形如 `RUN-...` |
| `trigger` | 第 2 节 15 类枚举之一 |
| `summary` | 需要用户决定的事项摘要 |
| `options[]` | 每项含 `option_id`、`description`、`impact`、`reversibility`（`reversible` / `hard_to_reverse` / `irreversible` / `unknown`） |
| `recommended_option` | 可选；含 `option_id` 与 `rationale`（理由） |
| `evidence_refs` | 支撑本次审批的证据引用 |
| `created_at` | 生成时间（date-time） |
| `status` | 初始为 `PENDING`，用户处置后转 `RESOLVED`，撤销为 `CANCELLED` |

流程：
1. manager-agent 命中触发 → 生成 `decisions/<dec-id>.request.json`（`status = PENDING`），工作流置 `WAITING_HUMAN`，append event。
2. 向用户展示 `summary`、各 `options`（含影响与可逆性）、以及可选的 `recommended_option` 及其理由。
3. 等待用户真实回复；**不轮询、不超时、不代答**。

## 5. approval-response.json 流程

权威 schema：`contracts/approval-response.schema.json`。至少包含字段：

| 字段 | 说明 |
|------|------|
| `decision_id` | 与 request 对应 |
| `workflow_id` | 归属 workflow |
| `task_id` / `run_id` | 必须与 request 中的值逐字段相同（包括 `null`） |
| `outcome` | `APPROVED` / `REJECTED` / `MODIFIED` |
| `chosen_option_id` | `APPROVED` 或 `MODIFIED` 时必须是 request `options[]` 中的 `option_id`；`REJECTED` 时必须为 `null` |
| `raw_user_reply_summary` | 用户原始回复的摘要（不得篡改语义） |
| `decided_by` | 人工决策者标识（非自动） |
| `decided_at` | 决策时间（date-time） |
| `notes` | 补充说明 |

流程：
1. 用户回复后，manager-agent 保存 `decisions/<dec-id>.response.json` 与原始回复摘要，append event。
2. 先校验 response 的四个绑定 ID 与 request 一致，并校验 `outcome` 与 `chosen_option_id` 的组合；不匹配则拒绝该 response，不能拿其他 task/run 的响应放行。通过后 request 的 `status` 更新为 `RESOLVED`。
3. 根据 `outcome`：
   - `APPROVED`：按 `chosen_option_id` 继续，并把该批准作为证据写入后续 Gate 与报告。
   - `REJECTED`：不执行被否决的操作，回到审批前的安全状态或改走非破坏性替代方案。
   - `MODIFIED`：按用户修改后的方案执行，记录差异。
4. 恢复被暂停的相关任务的调度。

## 6. 工作 Agent 侧行为

工作 Agent 遇到第 2 节任一节点时：

- **不擅自决定**，返回 `result_status = HUMAN_DECISION_REQUIRED`。
- 在 `result.json.decisions_required[]` 列出：可选方案、每个方案的影响与可逆性、支撑证据引用。
- 不执行任何依赖该决策的破坏性 / 不可逆 / 越权动作。

## 7. 相关文件

- 规则来源：`agents/common/APPROVAL_RULES.md`、`agents/common/SECURITY_RULES.md`（第 5 节破坏性操作）、`agents/common/GIT_RULES.md`（第 2 节 Git 审批情况）
- Schema：`contracts/approval-request.schema.json`、`contracts/approval-response.schema.json`
- Policy：`config/default-policy.yaml`（`approval.auto_timeout_approve: false`、`approval.silence_means_approval: false`）
- 关联文档：`docs/gate-checklists.md`、`docs/unsandboxed-test-policy.md`、`docs/evidence-and-claims.md`
