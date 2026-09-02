# Agent—LLM JSON 契约通信测试

`run-contract.mjs` 只通过 OpenClaw Gateway 向已注册 Agent 发送消息；它不直接请求任何 LLM API。每次运行固定发起 **10 次** 独立的轻量会话调用，随后由脚本使用 Runtime Guard + Ajv 校验 Agent 返回的 JSON/JSONL。

这是单一 Schema 的无重试冒烟检查。需要覆盖所有 Agent Schema、每份 Schema
3 个固定样例、每样例 10 次，并验证 JSON 清洗和同 Session 修复流程时，请在
项目根目录运行：

```powershell
npm run agent-json:matrix -- --run-id schema-matrix-<YYYYMMDD-HHMM> --concurrency 1 --timeout-seconds 120
```

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
