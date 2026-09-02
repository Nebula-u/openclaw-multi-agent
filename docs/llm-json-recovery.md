# Agent JSON 接收与失败恢复

worker 完成任务后只返回：

```text
一个完整的 `result.schema.json` JSON 对象（最终回复）。
```

接收器允许确定性的 BOM、唯一 code fence 或唯一前后解释文本清理；不会在多个候选 JSON 中猜测、补业务字段、修复截断 JSON 或把聊天回复当成 result。

清理后必须通过 `contracts/result.schema.json`，并精确匹配 task 身份、授权路径、input commit 和 context manifest SHA。只有全部通过后才原子发布到 `output/result.json` 并写 ingestion receipt。

生产 Orchestrator 在每次正常执行后提取最终回复，并由宿主原子写入
`<artifact_root>/.agent-raw/result.json.raw`，再执行解析、schema 和身份校验。失败时保留原始回复、failure receipt 与 Git recovery snapshot；JSON 修复回合继续复用同一 Session。缺少结果文件归类为 `OUTPUT_FILE_MISSING`，不再伪装成 `EMPTY_RESPONSE`。

原始 stdout/stderr、raw output 和错误摘要保留在 task artifact。失败内容不会覆盖上一次 attempt，也不会推进 candidate。

## Agent Schema 生成与清洗测试矩阵

真实 Gateway 测试由主矩阵和 `test-agent` 专用矩阵组成，共覆盖所有 19 个由
Agent 生成的 Schema：每份 Schema 固定三项不同的业务生成要求，每项独立
执行十次，共 570 个逻辑测试。报告逐个 Schema 汇总 `通过次数 / 有效执行次数`
与正确率；通信异常不计入质量分母。每次首次 JSON 清洗或 Schema 校验失败时，
测试脚本会在同一 Session 内最多请求两次 JSON 修复；修复请求明确说明这是
JSON 清洗工作流测试，不得调用工具或返回 JSON/JSONL 之外的内容。

```powershell
npm run agent-json:matrix -- `
  --run-id schema-matrix-<YYYYMMDD-HHMM> `
  --concurrency 1 `
  --timeout-seconds 120
```

重复次数固定为每个样例 10 次，不能通过命令行降低。结果写入：

```text
artifacts/agent-json-workflow/schema-matrix-<YYYYMMDD-HHMM>/summary.json
artifacts/agent-json-workflow/schema-matrix-<YYYYMMDD-HHMM>/report.md
artifacts/agent-json-workflow/schema-matrix-<YYYYMMDD-HHMM>/failures/
```

每个无效回复（即使随后修复成功）均保留原始未清洗文本、清洗结果、提示、
Runtime Guard 错误和中文诊断。通信异常会标记整个报告为 `INCOMPLETE`，并
从 JSON 质量通过率分母中排除。
