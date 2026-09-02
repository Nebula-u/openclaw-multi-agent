# 任务上下文包（Context Package）

> 本文件由 manager-agent 生成并放入任务 `artifact_root_abs`，作为被指派工作 Agent 的唯一权威上下文入口。
> 复制本骨架后逐节填充；散文用中文，字段名 / 命令 / 路径 / 代码标识符用英文。
> 所有路径必须为绝对路径（Windows `C:\...` 或 `<ABS_...>` 占位），禁止相对路径（`./`、`../`）。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `<PLACEHOLDER: requirement-agent | architect-agent | developer-agent | review-agent | test-agent | release-agent>`
- context_manifest_path_abs: `C:\path\to\openclaw-runtime\artifacts\TASK-...\RUN-...\context-manifest.json`
- isolation_mode: `UNSANDBOXED_LOCAL`

## workflow 摘要
<PLACEHOLDER: 用 2-4 句说明本 workflow 的总体目标、target_project_root_abs、integration_branch 与 base_commit。>

## 当前阶段
<PLACEHOLDER: 当前 workflow.status / current_phase，以及本任务在阶段中的位置。>

## 当前任务目标
<PLACEHOLDER: 本任务要达成的可核验目标；对应的 acceptance_criteria_ids（AC-001 形式）。>

## 范围与非范围
- 范围（In Scope）：<PLACEHOLDER: 本任务明确要做的事。>
- 非范围（Out of Scope）：<PLACEHOLDER: 明确不做、不得触碰的事。>

## 已批准需求摘要
<PLACEHOLDER: 引用已批准的 requirement-report 与 acceptance-criteria；标注 [OBSERVED: 来源文件/commit]。未批准内容不得作为事实。>

## 相关架构摘要
<PLACEHOLDER: 与本任务相关的模块 / 接口 / 数据模型 / ADR 引用；标注 [OBSERVED: architecture-report 来源]。>

## 当前候选 commit
<PLACEHOLDER: current_candidate_commit（如有）与 input_commit；[UNKNOWN: 尚无候选 commit 时如实标注]。>

## 前序 Agent 结论摘要
<PLACEHOLDER: 逐条列出上游 Agent 的 summary_for_manager 要点，标注来源角色与 result 文件；区分 [OBSERVED] / [INFERRED] / [PROPOSED] / [UNKNOWN]。>

## 已知风险与未解决问题
<PLACEHOLDER: 列出已识别风险、未决问题与阻塞项；标注分类与证据引用 [证据: EVD-... / CMD-...]。>

## 要求产生的输出
<PLACEHOLDER: 逐项列出 expected_output_paths_abs（绝对路径），例如 development-report.md、result.json、evidence.jsonl、command-records.jsonl。>

## 允许修改的绝对路径
<PLACEHOLDER: 逐条列出 allowed_write_paths_abs（绝对路径）。仅可在这些路径下写入。>

## 禁止修改的路径
<PLACEHOLDER: 逐条列出 forbidden_paths_abs（绝对路径），例如 target-project\.git、其他 Agent 的 worktree。>

## 需要执行的验证
<PLACEHOLDER: 需运行的自检 / 测试 / 静态检查命令（英文命令），每条须落库为 command-record 并采集 evidence；未执行的项如实标 [UNKNOWN: NOT_EXECUTED]，禁止编造结果。>
