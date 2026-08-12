# Provider 无关模型配置清理总结

> 日期：2026-08-12  
> 分支：`codex/lite-stategraph-supervisor`

## 本轮修改

- 删除厂商专属 Agent 路由样例与 provider 样例。
- 删除现役文档中的厂商缺陷、专属 JSON 模式和 Responses 协议设计。
- 测试不再断言具体厂商的 Pro/Flash 分工，改为校验通用静态 per-Agent 配置结构。
- 保留 builtin 与 generated Agent package 中现有默认 `model` 字段，避免本轮更新自动改变已安装 Agent。
- `config/agent-models.example.json` 作为唯一通用覆盖入口；Windows `-ModelConfig` 与 Linux `--model-config` 已支持对每个 Agent 指定不同模型。
- 新增 `config/openai-provider.example.json`，统一使用 OpenAI Chat Completions 兼容协议。

## Token 边界

| 配置 | 值 | 含义 |
| --- | ---: | --- |
| `contextWindow` | 128,000 | 单次模型上下文窗口 |
| Manager soft budget | 76,800 | 128k 的 60%，达到后轮换 Manager session |
| `max_session_tokens` | 200,000 | 单个持久 session 的累计 token 上限，不是单次请求窗口 |
| `maxTokens` | 49,152 | 单次输出上限，保持不变 |

## 设计效果

- 换模型只需修改配置，不改变 StateGraph、Supervisor、dispatch、Ajv 或结果摄取代码。
- 不允许 Agent 根据任务难度、失败次数或 token 使用量自行选择模型，避免不可审计的运行时路由漂移。
- 模型空输出、截断和 Schema 错误统一走 provider 无关的失败链路，不再为特定厂商维护行为假设。
- API Key 继续由 OpenClaw auth/profile 管理，模板、测试和报告不保存凭据。

## 已知边界

离线 `json-repair-prompts.mjs` 仍只用于契约测试；生产派发遇到无效 JSON 时会使当前 task attempt 失败，再通过新 `run_id` 重试。本轮没有把测试重写器接入生产链路，以免把模型回复修复和确定性状态机改造混在同一变更中。
