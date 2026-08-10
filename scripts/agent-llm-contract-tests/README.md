# Agent—LLM JSON 契约通信测试

`run-contract.mjs` 只通过 OpenClaw Gateway 向已注册 Agent 发送消息；它不直接请求任何 LLM API。每次运行固定发起 **10 次** 独立的轻量会话调用，随后由脚本使用 Runtime Guard + Ajv 校验 Agent 返回的 JSON/JSONL。

每个 `contracts/*.schema.json` 都在 `contract-scenarios.mjs` 中有一项明确配置、一个 `run-<contract>.mjs` 无参数入口：对应的 Agent 和 JSON/JSONL 格式。运行任一契约：

```powershell
node scripts/agent-llm-contract-tests/run-contract.mjs --schema result.schema.json
node scripts/agent-llm-contract-tests/run-contract.mjs --schema result.schema.json
node scripts/agent-llm-contract-tests/run-result.mjs
```

结果写入被 Git 忽略的 `artifacts/agent-llm-contract-tests/<run-id>/<schema>/`：

- `summary.json`：计划/实际调用数与通过/失败计数；
- `errors.json`：所有失败的索引；
- `failures/call-<n>.json`：原始 Agent 回复、清洗哈希、转换记录、分类和 Ajv 错误。

错误分类包含 `OUTPUT_TRUNCATED`、`SCHEMA_DRIFT`、`ENUM_VIOLATION`、`TYPE_VIOLATION`、`JSON_PARSE_ERROR`、`EMPTY_RESPONSE`、`AGENT_NO_TEXT_RESPONSE` 与 `AGENT_COMMUNICATION_ERROR`。脚本不重试，因此每次运行严格保持 10 次 Agent 调用。

## 全量 JSON Schema 矩阵测试

若要检查所有可由 Agent 生成的 JSON/JSONL Schema，以及回复经过现有清洗和 Runtime Guard/Ajv 处理后的准确性，运行：

```bash
npm run agent-json-schema:matrix
```

该命令覆盖 `CONTRACT_SCENARIOS` 中的 23 个 Schema。每个场景固定有 5 个不同业务需求的 prompt，每个 prompt 原样发送 20 次，每个场景 100 次，全量运行计划为 2300 次 Gateway 调用。每次调用使用独立 session；prompt 明确禁止工具调用、文件操作和后续任务，并要求 Agent 回复唯一 JSON/JSONL 后立即结束。脚本不做 JSON 修写重试，也不补发通信失败。

只测试一个场景时可使用稳定场景名，例如：

```bash
npm run agent-json-schema:matrix -- --scenario result
```

默认结果写入 `artifacts/agent-json-schema-matrix/<run-id>/`：

- `manifest.json`：运行参数、场景和计划调用数；
- `prompts.json`：每个场景的 5 个完整 prompt 及 SHA-256；
- `results.jsonl`：每次调用的原始回复、清洗/校验结果和分类；
- `failures/`：失败调用的完整复核证据；
- `summary.json`、`report.md`：按场景和 prompt 的统计报告。

内部确定性 Schema 不会发送给 Agent，但每次运行开始时会由 Runtime Guard self-check 编译全部 `contracts/*.schema.json`。
