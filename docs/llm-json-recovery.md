# Agent JSON 恢复与接收边界

## 两类重试不可混淆

### JSON 重新生成

当 Agent 进程成功，但 `.agent-raw` 中的 JSON 无法解析、Schema 不合法或违反本地接收边界时，dispatcher 在同一个 run/session 中要求重写结构化文件。最多 2 次；不得重新执行任务、修改代码、切换 Agent 或改变 context manifest。

### Agent attempt 重试

进程失败、Gate 失败或 JSON 恢复预算耗尽时，StateGraph 创建新 run/session/worktree。初次加 2 次自动重试，共 3 次；之后进入人工升级。

## 原始输出

Agent 只写：

```text
<artifact_root>/.agent-raw/route-plan.json.raw
<artifact_root>/.agent-raw/result.json.raw
```

本地代码在清洗前把原文、原文字节 SHA、cycle 和 transformations 追加到 `logs/agent-output.jsonl`。stdout、stderr、launcher 和 process result 写入 `logs/agent-process.jsonl`。失败原文不覆盖。

## 确定性清洗

允许的变换仅包括 BOM、唯一 Markdown code fence 和唯一解释性前后缀。系统不会：

- 猜测多个候选 JSON；
- 补业务字段或修改 enum；
- 把聊天回复当作文件结果；
- 从截断 JSON 推断缺失内容；
- 接受路径逃逸、目录、symlink 或 junction 代替文件。

## Schema 与身份

清洗后使用 Ajv 校验 `route-plan.schema.json` 或 `result.schema.json`。result 还必须精确匹配 checkpoint 中的 workflow、task、run、Agent、attempt、worktree、artifact root、input commit 和 context manifest SHA。

TEST 必须声明 `SANDBOXED_DOCKER`，并逐字匹配 runner 通过 OpenClaw effective config、sandbox list/explain 和 `docker inspect` 交叉验证得到的 attestation。

## 引用文件

`report_files`、`command_record_refs` 和 `evidence_refs` 必须位于授权 worktree 或本 run artifact，且是普通非 symlink 文件。

CommandRecord 逐行校验：

- task/run/Agent/attempt 身份；
- TEST 的 isolation mode；
- stdout/stderr 文件存在；
- 声明 SHA 与原始文件字节 SHA 一致。

Evidence 逐行校验 Schema；存在 `locator_abs + sha256` 时重新计算字节 SHA。接收 receipt 记录所有引用文件的最终 SHA。

## 原子发布

只有全部校验通过后，清洗后的文件才会原子写入：

```text
<artifact_root>/output/route-plan.json
<artifact_root>/output/result.json
```

同时写入 `.stategraph-ingest/*.receipt.json`。Agent 无权直接写最终 output，也不能通过自检替代本地 ingestion 或 Gate。

## 错误传播

JSON 错误先进入 same-session repair；修复失败后作为 task attempt 错误写入 checkpoint 的紧凑 `managerReports` 和事件链。Manager prompt 只接收摘要与 locator，完整原文保留在 artifact，避免重复消耗上下文。
