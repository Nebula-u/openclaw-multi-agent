# manager-agent / templates

本目录存放 manager-agent 运行时**快速参考模板**（workspace 本地副本）。权威模板位于项目根 `templates/`，安装时复制到此处。manager-agent 每次新建 workflow / task / decision / gate 时，以这些模板为骨架填充真实值。

包含（安装后）：

- `workflow.json` — 工作流状态骨架
- `task.json` — 任务定义骨架
- `context.md` / `context-manifest.json` — 上下文包骨架
- `result.json` / `evidence.jsonl` / `command-records.jsonl` — 结果与证据骨架（供校验对照）
- `requirement-report.md` / `architecture-report.md` / `development-report.md` / `review-report.md` / `test-report.md` / `release-report.md` / `final-report.md` — 各阶段报告骨架

填充规则：
- 所有路径字段填**绝对路径**。
- 所有 ID 用第 4 节（AGENTS.md）的生成方式产生。
- 事实分级字段必须真实标注 OBSERVED/INFERRED/PROPOSED/UNKNOWN。
- 不得留占位符进入正式产物；未知值填 `UNKNOWN` 并说明。
