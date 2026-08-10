# Agent JSON Schema 全量矩阵测试设计

## 目标

提供一个可重复执行的真实 Agent JSON/JSONL 检查脚本，覆盖仓库中全部 23 个 `CONTRACT_SCENARIOS`。每个场景固定生成 5 个不同业务需求的 prompt；每个 prompt 原样调用 20 次，单个场景共 100 次 Agent 调用。脚本对每次 Agent 最终回复经过现有清洗、解析和 Runtime Guard/Ajv 校验后再记录结果。

本次不把 12 个 `INTERNAL_CONTRACTS` 发给 Agent，因为它们由 Control Kernel/Monitor 确定性生成；但每次运行仍通过 `runtime-guard.mjs self-check` 编译全部 `contracts/*.schema.json`，避免内部 Schema 被遗漏或无法编译。

## 方案与边界

采用新增独立矩阵 runner 的方案，不改动现有 `agent-json-harness` 的重写恢复语义，也不复用当前 `run-contract.mjs` 的单 prompt/10 次约定。矩阵 runner 每次调用只发送一个最终回复请求，不执行 JSON-only repair，因此实际调用数严格等于计划调用数：23 × 5 × 20 = 2300。

每次调用使用独立 session key，避免历史回复污染；同一个 prompt 的 20 次调用使用完全相同的 prompt 文本，仅 session key 和结果序号不同。prompt 明确要求不调用工具、不读写文件、不继续执行任务、仅返回唯一 JSON/JSONL，回复完成后立即结束。

默认串行执行。脚本支持按场景筛选、超时、输出目录和运行 ID 参数，但不提供会改变单个 prompt 20 次语义的隐式重试。Gateway 传输失败记录为该次调用的通信失败，不自动补发。

## 场景与 Prompt

场景清单从 `CONTRACT_SCENARIOS` 读取，并与 `contracts/` 下的 Schema 文件交叉校验：

- 每个外部场景必须有 Schema 文件、Agent ID 和 JSON/JSONL 格式标记；
- 每个场景恰好有 5 个 prompt；
- 5 个 prompt 的业务需求、编号和完整文本均不同；
- prompt 内嵌当前 Schema 原文，且要求字段、类型、必填项、枚举和格式以该 Schema 为准；
- JSONL 场景要求每个非空行是完整 JSON 对象，并交给现有 JSONL 校验路径处理。

固定的 5 类业务变化覆盖：状态/结果汇报、审批/决策、审计/证据、配置/资源描述、异常/阻塞处理。每类使用不同主题和语言偏好，避免仅替换编号造成伪差异，但不要求 Agent 读仓库或虚构外部事实。

## 数据流与结果

```text
CONTRACT_SCENARIOS + contracts/*.schema.json
  -> 23 场景 × 5 prompt 计划
  -> Gateway 单独 Agent session（每 prompt × 20）
  -> textFromMessage / 原始回复
  -> ingestJsonText（BOM、唯一 Markdown 包装、唯一解释性包装）
  -> runtime-guard.mjs validate-file + Ajv
  -> 每次结果 JSONL + 失败文件 + 汇总 JSON/Markdown
```

每个运行目录包含：

- `manifest.json`：运行参数、场景数量、每场景 5 prompt、每 prompt 20 次和总计划调用数；
- `prompts.json`：每个场景的 prompt ID、Agent、格式、Schema 路径、prompt 原文和 SHA-256；
- `results.jsonl`：每次调用一行，包含场景、prompt、重复序号、session key、原始回复、清洗摘要、校验结果、分类和通信错误；
- `failures/`：失败调用的完整 prompt、原始回复和校验结果，便于人工复核；
- `summary.json` 与 `report.md`：按场景和 prompt 汇总 planned/executed/passed/failed 以及失败分类。

结果采用逐次追加和逐次更新汇总的方式；单次调用失败不会丢失此前结果。若 Gateway 建连或 Runtime Guard 自检在开始前失败，运行直接中止并写入 `ABORTED` 汇总；运行中通信错误只影响当前调用并继续后续计划。

## 错误分类

沿用现有分类模块，并将无法取得文本、Gateway 异常、清洗解析错误和 Ajv 错误分开记录：`AGENT_NO_TEXT_RESPONSE`、`AGENT_COMMUNICATION_ERROR`、`OUTPUT_TRUNCATED`、`JSON_PARSE_ERROR`、`EMPTY_RESPONSE`、`SCHEMA_DRIFT`、`ENUM_VIOLATION`、`TYPE_VIOLATION` 以及现有分类器产生的其他类别。脚本不猜测字段、不修复业务值、不把失败结果当作成功。

## 测试策略

离线测试覆盖：23 场景完整映射、每场景 5 个不同 prompt、默认 20 次/ prompt、总计划数 2300、同一 prompt 文本重复 20 次、独立 session、结果逐次落盘、JSON/JSONL 校验路径和运行中失败继续执行。真实运行只做一次轻量 smoke test，验证某个选定场景的 Agent 能返回文本并经过脚本校验；完整 2300 次由用户按需运行。

