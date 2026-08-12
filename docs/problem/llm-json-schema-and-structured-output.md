# LLM JSON Schema 与结构化输出边界

> 状态：本地契约闭环已启用；不依赖模型 API 的结构化输出扩展。

## 当前结论

项目将所有 LLM 输出视为不可信输入。Agent 先写入 `.agent-raw/**`，本地代码只做 BOM、唯一 fence 和唯一完整 JSON 值等可证明安全的清洗，然后执行 Ajv Schema、身份、路径、哈希和业务一致性校验。聊天文本或模型自述不能推进 workflow。

生产派发在解析或校验失败时会终止当前 task attempt，保留失败证据，并通过新的 `run_id` 和 artifact root 重试。测试 harness 中的同会话重写模板仍是离线验证工具，不宣称已接入生产派发。

## 保留要求

1. `structured_outputs` 必须由受信任 task package 声明，Agent 不得自行决定权威输出范围。
2. `result-ingest` 必须重新校验所有必需 JSON/JSONL；缺失、路径逃逸、多个候选或 Schema 不符均 fail-closed。
3. 模型/provider 配置不得改变上述本地边界，也不得绕过 Ajv。
4. 真实 LLM 契约测试必须记录 planned、executed、失败类型、模型引用和 Schema hash；未执行不能算通过。
5. 普通工具调用、Markdown 总结和用户对话不强制 JSON 格式。

## 非目标

- 不让 Agent 自行切换模型。
- 不把 prompt 中“仅输出 JSON”当作 Schema 保证。
- 不自动修正业务字段、枚举、数字、身份或审批结论。
- 不把测试 harness 的会话内重写能力描述为生产能力。
