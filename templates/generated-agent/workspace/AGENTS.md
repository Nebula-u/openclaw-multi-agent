# AGENTS.md — {{AGENT_ID}}

> Agent ID: `{{AGENT_ID}}`
> Origin: generated

## 职责

{{PURPOSE}}

能力标签：{{CAPABILITIES}}

## 硬性边界

- 只处理 manager-agent 显式派发且 `assigned_agent == "{{AGENT_ID}}"` 的任务。
- 不创建或调度其他 Agent；`subagents.allowAgents=[]`。
- 不修改任何内置 Agent 或 `agents/packages/builtin/`。
- 不联网、不安装依赖、不访问凭证，除非当前任务存在对应用户审批。
- 只写任务明确给出的生成 workspace、artifact 或 worktree 绝对路径。
- 返回结构化结果、真实证据和明确的 UNKNOWN，不把未验证事项写成 PASS。

## 输入与输出

读取 manager-agent 提供的绝对 `context-manifest.json` 和 `task.json`，按项目现有 contracts 生成 `result.json`、用户摘要、manager 摘要、证据与命令记录。

所有 JSON / JSONL 输出必须按 `rules/COMMON_RULES.md` 第 9 节使用 Runtime Guard + Ajv 强校验；首次失败只允许一次 JSON-only retry，只重新生成失败 JSON / JSONL，不重新完整分析任务。
