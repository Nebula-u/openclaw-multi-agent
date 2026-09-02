# 需求分析报告（Requirement Report）

> 由 requirement-agent 生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 凡涉及事实处必须用分类占位：`[OBSERVED: ...]`（直接观察）/ `[INFERRED: ...]`（推断）/ `[PROPOSED: ...]`（建议）/ `[UNKNOWN: ...]`（未知）。禁止编造。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `requirement-agent`
- input_commit: `PLACEHOLDER_INPUT_COMMIT_SHA`
- generated_at: `2026-01-01T00:00:00Z`
- isolation_mode: `UNSANDBOXED_LOCAL`

## 证据分类说明
- `OBSERVED`：来自用户输入 / 文件 / 命令输出的直接证据，附 `[证据: EVD-... / CMD-...]`。
- `INFERRED`：基于已观察证据的合理推断。
- `PROPOSED`：本 Agent 提出、尚待批准的建议。
- `UNKNOWN`：信息缺失或未验证，如实标注。

## 目标（Goals）
<PLACEHOLDER: 逐条列出业务 / 技术目标。示例：`[OBSERVED: 用户要求 ...（来源引用）]`。>

## 范围（In Scope）
<PLACEHOLDER: 明确纳入的需求项。>

## 非范围（Out of Scope）
<PLACEHOLDER: 明确排除的需求项，避免范围蔓延。>

## 假设（Assumptions）
<PLACEHOLDER: 逐条列出假设，标注 `[INFERRED: ...]` 或 `[UNKNOWN: ...]`。>

## 依赖（Dependencies）
<PLACEHOLDER: 外部系统 / 上游任务 / 数据 / 审批依赖。>

## 验收标准（Acceptance Criteria）
> id 采用 `AC-001` 形式（`^AC-[0-9]{3,}$`）。priority ∈ MUST | SHOULD | COULD | WONT；status ∈ PROPOSED | APPROVED | IMPLEMENTED | VERIFIED | FAILED | UNKNOWN。

| id | statement | priority | verification_method | source | status |
|----|-----------|----------|---------------------|--------|--------|
| AC-001 | <PLACEHOLDER: 可验证的验收陈述> | MUST | <PLACEHOLDER: 测试/演示/检查> | `[OBSERVED: 来源引用]` | PROPOSED |
| AC-002 | <PLACEHOLDER> | SHOULD | <PLACEHOLDER> | `[OBSERVED: ...]` | PROPOSED |

## 歧义与冲突（Ambiguities & Conflicts）
<PLACEHOLDER: 需求间的歧义 / 冲突 / 待澄清项，标注 `[UNKNOWN: ...]` 并给出待决问题。>

## 追踪关系（Traceability）
<PLACEHOLDER: 每条 AC ↔ 来源需求 / 用户输入引用的映射表。>

## 限制与未解决项（Limitations & Unresolved）
<PLACEHOLDER: 本报告的分析限制、未覆盖内容与需人工决策项（`[UNKNOWN: ...]`）。>
