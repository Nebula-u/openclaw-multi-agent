# manager-agent / templates

本目录存放 manager-agent 运行时快速参考模板。SQLite Control Kernel 保存 workflow/route/task/approval 事实；Manager 只能按当前会话产出 schema-valid request，不能准备或写入控制状态。

包含（安装后）：

- `manager-request.json` — 已确认 CREATE 请求参考
- `manager-request.change.json` — 已确认 CHANGE 请求参考
- `manager-request.decision.json` — 已确认 DECISION 请求参考
- `task.json` — 任务定义骨架
- `context.md` / `context-manifest.json` — 上下文包骨架
- `result.json` / `evidence.jsonl` / `command-records.jsonl` — 结果与证据骨架（供校验对照）
- `requirement-report.md` / `architecture-report.md` / `development-report.md` / `review-report.md` / `test-report.md` / `release-report.md` / `final-report.md` — 各阶段报告骨架

填充规则：
- 所有路径字段填**绝对路径**。
- 所有 ID 用第 4 节（AGENTS.md）的生成方式产生。
- 只能复制一个与本次请求类型相符的 manager request 参考；写入前替换全部 `<...>` 参考值，不能把示例值直接提交。
- 事实分级字段必须真实标注 OBSERVED/INFERRED/PROPOSED/UNKNOWN。
- 不得留占位符进入正式产物；未知值填 `UNKNOWN` 并说明。

workflow 状态、dispatch、approval 和 completion 不使用 workspace 模板；它们必须由 Orchestrator/Control Kernel 代码生成。
