# model-routing.md — 模型、协议与空输出恢复

## 当前路由

| Agent | 模型引用 | 协议 | 用途 |
| --- | --- | --- | --- |
| manager-agent | `newapi-responses/gpt-5.6-luna` | Responses | 调度、工具调用、多轮状态 |
| requirement-agent | `newapi/gpt-5.6-terra` | Chat Completions | 需求理解与结构化输出 |
| architect-agent | `newapi/gpt-5.6-sol` | Chat Completions | 架构设计与深度推理 |
| developer-agent | `newapi-responses/gpt-5.6-luna` | Responses | 代码执行、工具链、多轮修改 |
| review-agent | `newapi/gpt-5.6-sol` | Chat Completions | 代码审查与深度推理 |
| test-agent | `newapi-responses/gpt-5.6-luna` | Responses | 测试执行与日志分析 |
| release-agent | `newapi-responses/gpt-5.6-luna` | Responses | 运维前验证与工具执行 |

`newapi-responses` 是只包含 luna 的独立 provider，adapter 为 `openai-responses`。它与原 `newapi` provider 并存；后者继续使用 `openai-completions`，因此普通 Chat API 不会被替换或失效。

配置样例见 `config/newapi-responses-provider.example.json` 与 `config/agent-models.newapi-routing.example.json`。不得把 API Key 写入样例、仓库、prompt、测试报告或运行日志。

## 空输出恢复

当模型已完成却返回空字符串，并且该轮没有 function/custom/web-search 工具调用、所需 artifact 也尚未通过验证时，当前 Agent 必须在同一会话最多额外重试 3 次。三次后仍为空，记录 `EMPTY_LLM_OUTPUT` 并阻断工作流推进。

纯工具调用没有文本是有效中间状态，不触发空输出重试。若必需 artifact 已通过 manager 与 Runtime Guard 校验，最终聊天文本为空也不得重新执行可能有副作用的工具任务。

非空但不符合 JSON Schema 的回复仍遵循原有的一次 JSON-only retry 规则。所有最终 JSON / JSONL 都必须经 Runtime Guard + Ajv 校验。
