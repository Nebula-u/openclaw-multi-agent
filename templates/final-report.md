# 最终综合报告（Manager Final Report）

> 由 manager-agent 综合各 Agent 的 result 与报告生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 必须区分事实与推断：`[OBSERVED: ...]` / `[INFERRED: ...]` / `[PROPOSED: ...]` / `[UNKNOWN: ...]`。禁止编造；不得把"仅生成未验证"的产物表述为"已验证"。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- integration_branch: `sdlc/integration`
- final_candidate_commit: `PLACEHOLDER_CANDIDATE_COMMIT_SHA`
- generated_at: `2026-01-01T00:00:00Z`
- isolation_mode: `UNSANDBOXED_LOCAL`

## 各 Agent 原始总结（Per-Agent Raw Summaries）
> 逐角色粘贴该 Agent 的 `summary_for_manager` 原文，标注来源角色与 result 文件绝对路径；不得改写其结论。

- 来源角色 `requirement-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`
- 来源角色 `architect-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`
- 来源角色 `developer-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`
- 来源角色 `review-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`
- 来源角色 `test-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`
- 来源角色 `release-agent`：<PLACEHOLDER: 原始 summary_for_manager> `[来源: <ABS_PATH>\result.json]`

## 最终候选 commit（Final Candidate Commit）
<PLACEHOLDER: final_candidate_commit，及其与 reviewed_commit / tested_commit 的一致性核对结论 `[OBSERVED: ...]`。>

## 测试事实（Test Facts）
<PLACEHOLDER: 引用 test-report 的命令 / 退出码 / passed·failed·skipped·errors 数量 / 日志哈希；标注 `[OBSERVED: 来源 CMD-... / EVD-...]`。>

## 审查发现（Review Findings）
<PLACEHOLDER: 汇总 blocking / 未解决的 FIND-... findings 及其 status；静态工具未执行项标 `[UNKNOWN: NOT_EXECUTED]`。>

## 安全状态（Security Status）
<PLACEHOLDER: 安全检查执行与否及结论；未执行标 `[UNKNOWN: NOT_EXECUTED]`，禁止假定通过。>

## 已知问题（Known Issues）
<PLACEHOLDER: 跨阶段汇总的遗留问题清单及严重度。>

## 未验证内容（Unverified）
<PLACEHOLDER: 仅生成但未经执行 / 未经验证的产物与声明，逐条标 `[UNKNOWN: ...]`。>

## 发布前判定（Pre-Release Verdict）
- verdict: `<PLACEHOLDER: GO | NO_GO | HOLD>`
- <PLACEHOLDER: `GO` 仅表示 `READY_FOR_OPERATIONS_HANDOFF`，不代表已部署；给出判定理由与依据引用。>

## 运维交接清单（Ops Handoff Checklist）
<PLACEHOLDER: 部署前置条件、回滚计划位置、配置 / 密钥、监控 / 告警、责任人；引用 release-report。>

## 结论分类（Outcome Classification）
> 每一条产出必须归入以下类别之一，禁止含糊。

- 已完成（Completed）：<PLACEHOLDER: 已交付的工作项。>
- 已验证（Verified）：<PLACEHOLDER: 有 `[OBSERVED: 证据]` 支撑的已验证项。>
- 仅生成未验证（Generated but Unverified）：<PLACEHOLDER: 已产出但缺执行证据的项，标 `[UNKNOWN: ...]`。>
- 环境阻塞（Environment-Blocked）：<PLACEHOLDER: 因环境 / 权限 / 依赖阻塞而未能完成的项。>
- 仍存在问题（Outstanding Issues）：<PLACEHOLDER: 尚未解决、需后续处理或人工决策的问题。>
