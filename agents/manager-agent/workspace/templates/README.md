# manager-agent / templates

本目录存放 manager-agent 运行时快速参考模板。最新 checkpoint 保存 workflow/route/task/approval/Gate 事实；Manager 只能按派发消息产出候选 `route-plan.json.raw`，不能准备或写入控制状态。

包含（安装后）：

- `task.json` — 任务定义骨架
- `context.md` / `context-manifest.json` — 上下文包骨架
- `result.json` / `evidence.jsonl` / `command-records.jsonl` — 结果与证据骨架（供校验对照）
- `requirement-report.md` / `architecture-report.md` / `development-report.md` / `review-report.md` / `test-report.md` / `release-report.md` / `final-report.md` — 各阶段报告骨架

填充规则：
- 所有路径字段填**绝对路径**。
- 所有 ID 用第 4 节（AGENTS.md）的生成方式产生。
- 事实分级字段必须真实标注 OBSERVED/INFERRED/PROPOSED/UNKNOWN。
- 不得留占位符进入正式产物；未知值填 `UNKNOWN` 并说明。

workflow 状态、事件、dispatch、reconcile、approval 和 completion 不使用 workspace 模板；它们必须由 StateGraph/checkpointer 代码生成。
