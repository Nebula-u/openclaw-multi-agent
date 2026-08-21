# Agent JSON 接收与失败恢复

worker 只写：

```text
<artifact_root>/.agent-raw/result.json.raw
```

接收器允许确定性的 BOM、唯一 code fence 或唯一前后解释文本清理；不会在多个候选 JSON 中猜测、补业务字段、修复截断 JSON 或把聊天回复当成 result。

清理后必须通过 `contracts/result.schema.json`，并精确匹配 task 身份、授权路径、input commit 和 context manifest SHA。只有全部通过后才原子发布到 `output/result.json` 并写 ingestion receipt。

当前生产 Orchestrator 不在同一 Session 内自动让模型“修 JSON”。解析、schema 或身份失败会结束该 execution，记录 failure receipt，并捕获 Git recovery snapshot；后续由 task attempt 机制使用新的 attempt/Session 重试。`scripts/agent-json-harness/` 中的 repair retry 只用于离线模型契约评估，不是生产调度路径。

原始 stdout/stderr、raw output 和错误摘要保留在 task artifact。失败内容不会覆盖上一次 attempt，也不会推进 candidate。
