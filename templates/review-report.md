# 代码审查报告（Code Review Report）

> 由 review-agent 生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 凡涉及事实处必须用分类占位：`[OBSERVED: ...]` / `[INFERRED: ...]` / `[PROPOSED: ...]` / `[UNKNOWN: ...]`。禁止编造。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `review-agent`
- review_scope: `<PLACEHOLDER: PRODUCTION_CODE | TEST_CODE | BOTH>`
- generated_at: `2026-01-01T00:00:00Z`
- isolation_mode: `UNSANDBOXED_LOCAL`

## 审查范围（Review Scope）
<PLACEHOLDER: 说明审查覆盖的文件 / 变更集 / diff 基线，标注 `[OBSERVED: 对应 commit 范围]`。>

## 候选 commit（Reviewed Commit）
- reviewed_commit: `PLACEHOLDER_REVIEWED_COMMIT_SHA`
- <PLACEHOLDER: 说明该 commit 是否与 development-report 的 output_commit 一致。>

## 审查发现（Findings）
> finding_id 采用 `FIND-001` 形式（`^FIND-`）。severity ∈ BLOCKER | CRITICAL | HIGH | MEDIUM | LOW | INFO；status ∈ OPEN | RESOLVED | WONT_FIX | UNKNOWN | NOT_EXECUTED；blocking ∈ true | false。

| finding_id | severity | category | file | line | commit | evidence | remediation | blocking | status |
|------------|----------|----------|------|------|--------|----------|-------------|----------|--------|
| FIND-001 | HIGH | <PLACEHOLDER: correctness/security/style/...> | `<ABS_PATH>` | 42 | `PLACEHOLDER_COMMIT_SHA` | `[证据: EVD-...]` | <PLACEHOLDER: 修复建议> | true | OPEN |
| FIND-002 | LOW | <PLACEHOLDER> | `<ABS_PATH>` | 10 | `PLACEHOLDER_COMMIT_SHA` | `[证据: EVD-...]` | <PLACEHOLDER> | false | OPEN |

## 静态工具执行状态（Static Analysis Status）
> 未执行的工具必须如实标 `NOT_EXECUTED`；不确定标 `UNKNOWN`。禁止把未执行标为通过。

| tool | executed | status | evidence |
|------|----------|--------|----------|
| `eslint` | <yes/no> | `<PLACEHOLDER: PASS | FAIL | NOT_EXECUTED | UNKNOWN>` | `[证据: CMD-... / EVD-...]` |
| `tsc --noEmit` | no | `NOT_EXECUTED` | - |

## 判定（Verdict）
- verdict: `<PLACEHOLDER: APPROVE | REQUEST_CHANGES | BLOCKED>`
- 理由：<PLACEHOLDER: 结合 blocking findings 与静态工具状态说明判定依据。>

## 限制与未解决项（Limitations & Unresolved）
<PLACEHOLDER: 审查未覆盖的范围、缺失的工具证据（`[UNKNOWN: ...]`）与需人工决策项。>
