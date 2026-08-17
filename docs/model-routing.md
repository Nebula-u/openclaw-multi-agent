# model-routing.md — 模型、协议与空输出恢复

## 当前路由

| Agent | 模型引用 | 协议 | 用途 |
| --- | --- | --- | --- |
| manager-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 调度、工具调用、多轮状态 |
| requirement-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 需求理解与结构化输出 |
| architect-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 架构设计与深度推理 |
| developer-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 代码执行、工具链、多轮修改 |
| review-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 代码审查与深度推理 |
| test-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 测试执行与日志分析 |
| release-agent | `deepseek/deepseek-v4-pro` | Chat Completions API | 运维前验证与工具执行 |

当前所有 7 个 Agent 统一使用 `deepseek` provider 的 `https://api.deepseek.com` + `openai-completions`，模型固定为 `deepseek-v4-pro`。不再依赖 Responses API；保留的 `deepseek-responses` 样例不参与默认路由。

配置样例见 `config/agent-models.deepseek-routing.example.json`。不得把 API Key 写入样例、仓库、prompt、测试报告或运行日志。

官方依据：<https://api-docs.deepseek.com/zh-cn/guides/responses_api>、<https://api-docs.deepseek.com/zh-cn/api/create-chat-completion>、<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>。

## JSON 契约输出与恢复

JSON/JSONL 契约回复先保存原文和 SHA-256，只做可证明安全的包装清洗：BOM、唯一 Markdown fence、唯一解释性前后缀中的完整 JSON 值或 JSONL 连续块。绝不自动修改业务字段、ID、日期、数字、类型或 enum；多个 JSON 候选直接失败，交由模型重写。

空 content、截断、JSON parse error、enum/type 违规和 schema drift 统一使用首次调用之外最多 **2 次** 的同会话重写预算。纯工具调用没有文本是有效中间状态，不触发空输出重试；已通过 Guard 的 artifact 不得因聊天文本为空而重复产生。

固定模板会逐项报告 Ajv 字段路径、关键字、期望 enum/type 与收到值。最终权威判断始终是 Runtime Guard + Ajv，而非模型自述。

## DeepSeek JSON Output 边界

DeepSeek 官方 JSON Output 为 Chat Completions 请求的 `response_format: {"type":"json_object"}`；system 或 user prompt 必须包含 `json` 并给出输出形态示例，且应配置足够 `max_tokens`。它保证合法 JSON 字符串，不提供本项目 JSON Schema strict 校验，也可能返回空 `content`。因此本项目的 prompt、清洗、Ajv 与重试都保留。

当前已安装 OpenClaw `2026.7.1-2`（据 2026-07-23 探测，见 `docs/compatibility-report.md`；若环境已升级需人工复核当前实际版本）的 Gateway `chat.send` 协议不接受/转发请求级 `responseFormat`，不能把该参数可靠地附加到已注册 Agent 的单次 JSON 契约调用；静态写入全部 Agent 的 `params.response_format` 会破坏工具调用和 Markdown 会话，未采用。升级或扩展 Gateway 增加请求级透传后，JSON 单对象调用应传 `response_format: {"type":"json_object"}`；JSONL 继续使用本地 Guard 路径。详见 [llm-json-recovery.md](llm-json-recovery.md)。
