# LLM JSON Schema 与结构化输出待解决问题

> 状态：部分处理；本地 JSON 回复恢复已实现，Gateway 请求级 DeepSeek JSON Output 仍受协议能力阻塞。
> 记录日期：2026-08-03
> 来源：对 7 个内置 Agent、Runtime Guard、Gateway LLM harness、OpenClaw Gateway 客户端及历史真实 LLM 测试产物的审计。

## 结论摘要

当前项目已具备 JSON/JSONL 的事后 Ajv 校验能力与保守回复恢复，但尚未形成“生成 JSON 时由 LLM API 强制使用 JSON Schema 输出”的完整闭环。

2026-08-04 更新：`scripts/runtime-core/json-ingestion.mjs` 已支持 BOM、唯一 Markdown fence 与唯一解释性包裹的确定性提取，并拒绝多个候选；`json-repair-prompts.mjs` 会区分 enum/type、schema drift、截断和空输出，首次调用外最多重试两次。DeepSeek JSON Output 官方参数为 `response_format: {"type":"json_object"}`，但当前 OpenClaw Gateway `chat.send` schema 不含请求级 `responseFormat`，不能可靠透传；本项目不会把它错误地全局静态施加给工具调用与 Markdown 对话。

- 7 个内置 Agent 的源规则和当前 runtime 规则均要求使用 Runtime Guard + Ajv 校验 JSON/JSONL，并在首次失败后仅允许一次 JSON-only retry。
- Manager 在派发前通过 `task-validate` 校验输入包 JSON/JSONL；`result-ingest` 在入库前按 task 固定的 `structured_outputs` 自动校验 `result.json`、`evidence.jsonl`、`command-records.jsonl`、`review-findings.json` 与 `release-decision.json` 等核心产物。
- Agent 的自然语言会话回复、`user-summary.md` 和 `manager-summary.md` 是 Markdown，不是 JSON Schema 契约；它们不得成为工作流状态推进的权威依据。
- 项目没有使用 `response_format`、`json_schema`、`json_object`、`text.format` 或其他 LLM API 结构化输出参数。现有 Gateway harness 只在 prompt 中要求“仅输出 JSON”，然后再由 Guard 校验。
- 历史真实 LLM 测试计划 190 个用例，仅执行 60 个，16 个在一次 schema retry 后仍失败。因此不能声明所有 Agent 已完成真实 JSON 合规验证。

## P0-1：角色专属结构化产物未被控制层逐项强制校验

### 现状与根因

`scripts/runtime-guard.mjs validate-file` 负责 Agent 自检和当前契约自检；Control Kernel v2 的 `result-ingest` 会根据 task 中固定的 `structured_outputs` 逐项重验需求、架构、开发和测试阶段的专属 JSON。Agent 自检不能替代入库前复核。

这意味着某个 Agent 遗漏本地自检时，Manager 仍可能在文件存在的情况下继续推进。

### 解决办法

1. 扩展 `contracts/task.schema.json`，新增受版本控制的 `structured_outputs` 清单。每项至少包含：`path`、`schema_path`、`format`（`json` 或 `jsonl`）、`required`、`producer`。
2. 由 Manager 在创建 task 时，按 `task_type` 生成该清单；不得让 Agent 自行决定要校验哪些跨 Agent 数据文件。
3. 已由 `result-ingest` 对每个 `structured_outputs` 项执行文件存在性、路径范围、JSON/JSONL 解析和 Ajv Schema 校验；任何缺失或失败都不会提交 `COMPLETED`。
4. 保留现有的作用域、证据、hash 和 Gate 校验；专属产物校验是补充，不替代它们。
5. 保留任务仓库和结果摄取反例测试：将任一声明 JSON 改为非法、缺失或替换为错误 Schema 时，Control Kernel 必须拒绝提交。

### 验收标准

- 任一已声明跨 Agent JSON/JSONL 文件不合法、缺失、越出 artifact 根目录或 schema 路径不受允许时，Manager 不得推进。
- 所有 7 个内置 Agent 的结构化输出均在 task 清单中有明确的 producer 与 Schema。
- `npm test` 包含以上反例，并全部通过。

## P0-2：LLM 调用未启用 API 级 JSON Schema 结构化输出

### 现状与根因

`scripts/agent-json-harness/gateway-llm-client.mjs` 通过 Gateway 的 `chat.send` 只发送 `agentId`、`sessionKey`、`message`、`thinking`、`deliver` 与超时参数。项目配置和代码中没有传递 `response_format` 或 JSON Schema。

当前 OpenClaw 安装版本支持在 Agent/模型 `params` 中处理 `response_format`，并支持 `json_object` / `json_schema`。但 Gateway `chat.send` 客户端没有项目可用的逐请求结构化输出参数。把静态 JSON mode 写到所有 Agent 的全局参数会干扰工具调用、普通分析与 Markdown 总结，因此不能作为直接修复方案。

### 解决办法

1. 先对 `newapi/gpt-5.6-terra`、`newapi/gpt-5.6-sol` 与 `newapi-responses/gpt-5.6-luna` 做不含凭据的能力探测，确认每个 provider/API 家族对 JSON Schema strict mode 的实际兼容性、Schema 子集和工具调用组合限制。
2. 为 Gateway 增加或升级到支持请求级 `response_format` / `text.format` 的接口；参数必须仅用于“输出一个 JSON/JSONL 契约”的调用，不得全局写入所有会话。
3. 在项目侧提供唯一的结构化调用封装。它接收受信任的 `schema_path`，读取 Schema 后按 provider 转换为 `json_schema` 请求参数；记录模型、协议、schema SHA-256、是否 strict、响应 ID 和 Ajv 结果，但不得记录密钥。
4. 对不支持 strict JSON Schema 的模型，明确标记为不合格，不得静默退化为“prompt 要求 JSON”。如业务必须保留该模型，只能将其输出视为非权威草稿，并交由支持结构化输出的模型重新生成契约。
5. 保留 Ajv 后验校验。API 结构化输出降低格式失败率，但不能替代本地 Schema、作用域、证据和业务一致性验证。

### 验收标准

- 每次需要直接生成 JSON/JSONL 契约的 LLM 调用都有请求级结构化输出配置，并记录 schema SHA-256 与 strict 状态。
- 对每个 provider/API 家族有成功与故意非法输入的集成测试，能证明请求确实包含结构化输出参数，而非仅依赖 prompt。
- 普通工具调用和 Markdown 总结会话不被错误施加 JSON mode。

## P1-1：会话文本未受 Schema 约束，边界需明确

### 现状与根因

Agent 之间通过 OpenClaw 会话交换任务提示和完成通知，同时写入 artifact。会话文本本身并非 JSON Schema；当前设计允许 `user-summary.md` / `manager-summary.md` 使用 Markdown。

如果未来 Manager 使用自然语言会话回复而不是受校验 artifact 推进状态，就会绕过控制面校验。

### 解决办法

1. 明确规定：状态推进、审批、Gate、任务结果和跨 Agent 机器可读数据只能读取控制文件及 `structured_outputs`；会话消息仅作通知。
2. Manager 接收 Agent 完成通知后，必须从 artifact 路径重新读取并校验，不得解析聊天文本决定 `COMPLETED`、`PASS` 或 `GO`。
3. 在测试中伪造“聊天文本声称完成、artifact 缺失或非法”的情况，验证 Manager/Guard 必须 `HOLD`。

### 验收标准

- 任意自然语言会话回复无法单独让 workflow 前进。
- 任务、审批和 Gate 的全部权威数据都能追溯到已通过 Schema 校验的文件。

## P1-2：真实 LLM 契约测试未全量完成且未作为通过门槛

### 现状与根因

历史运行 `artifacts/agent-llm-json/llm-gateway-complete-20260731-1720/summary.json` 计划 190 个用例，仅执行 60 个；其中 16 个最终失败。当前 `npm test` 只运行离线 harness 测试，不调用真实模型，因此通过并不代表真实模型契约通过。

### 解决办法

1. 修改真实测试收集器：计划数、执行数不一致，或任一最终失败，必须以非零退出码结束并生成完整失败包。
2. 每次真实测试开始前生成不可重复的 run ID；记录模型路由、Agent、Schema 哈希、用例数、重试次数和最终状态。
3. 最低覆盖为 20 份契约、每份 5 个差异化需求、每例 2 次独立会话，共 200 次首轮调用；若任一调用不可执行，结果为 `NOT_EXECUTED` 且整个验证不通过。
4. 在启用 P0-2 后，分别覆盖 Chat Completions 与 Responses 路由，并测试 strict JSON Schema、工具调用无文本、空输出重试和一次 JSON-only retry。

### 验收标准

- 汇总中的 `planned == executed`，无 `NOT_EXECUTED`，无最终失败。
- 真实测试失败时 CI/本地命令返回非零，不能被离线单元测试掩盖。
- 测试报告不包含凭据、完整用户敏感输入或未脱敏的会话日志。

## 推荐实施顺序与提交边界

1. 先完成 P0-1：任务结构化输出清单、Guard 强制校验和单元测试。单独提交。
2. 完成 P1-1：固定“artifact 是权威、会话文本仅通知”的边界与反例测试。单独提交。
3. 完成 P0-2：先完成 OpenClaw/Gateway 请求级结构化输出能力验证，再接入项目封装和 provider 集成测试。单独提交；该项属于运行时调用架构变更，需要人工审批。
4. 最后完成 P1-2：真实 LLM 全量测试门槛与报告。单独提交。

每步实现、测试并由用户检查/验收后，按项目长期规则同步更新 `CHANGELOG.md`、`README.md` 与 `docs/current-progress-assessment.md`。

## 非目标

- 不把 JSON Schema 当作业务正确性、证据真实性或审批有效性的替代品。
- 不在仓库、报告、日志或问题记录中保存 API Key、Token 或完整认证输出。
- 不通过给所有 Agent 静态设置 JSON mode 的方式破坏正常的工具调用和自然语言总结。
