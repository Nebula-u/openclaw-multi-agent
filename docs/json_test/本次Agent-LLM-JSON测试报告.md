# Agent LLM JSON 测试报告

## 结论

本次测试只评估已注册 Agent 的最终 LLM 回复：Agent 不调用工具、不读写工作区文件；脚本把原样回复交给 `scripts/runtime-guard.mjs validate-file` 做 JSON Schema 校验。首次失败时，同一 session 仅接收一次纠错提示并重新回复。

运行 ID 为 `llm-gateway-complete-20260731-1720`。按完整命令计划 190 个首轮调用；实际完成了 60 个有效 LLM 用例。之后 Gateway 会话不再返回回复，收集器按设计中止运行，未把“两次都未获得 LLM 回复”的传输故障误报为模型错误。因此本报告的正确率只代表这 60 个有效用例，不能外推为全部 19 个契约场景的最终结果。

| 指标 | 数值 | 正确率 |
| --- | ---: | ---: |
| 首次 Schema 校验通过 | 28 / 60 | 46.7% |
| 首次失败后一次重写成功 | 16 / 60 | 26.7% |
| 一次重写后的最终通过 | 44 / 60 | 73.3% |
| 重写后仍不符合 Schema | 16 / 60 | 26.7% |
| 首次失败的纠错成功率 | 16 / 32 | 50.0% |

最终失败的 Guard 错误码分布为：`JSON_PARSE_ERROR` 13 次、`SCHEMA_ENUM` 1 次、`SCHEMA_PATTERN` 1 次、`SCHEMA_TYPE` 1 次。Gateway 传输中断发生在后续未完成的调用阶段，不计入这 16 个已打包 JSON 失败项。

## 错误原因

1. JSON 格式不纯。部分回复含 Markdown 代码块、说明文字或多个 JSON 片段，导致 `JSON_PARSE_ERROR`。这不是字段语义问题，而是最终回复没有遵守“只输出一个 JSON/JSONL”的协议。
2. 枚举值不符合契约。已观察到 `SCHEMA_ENUM`：LLM 用常见业务状态替代了 Schema 的封闭枚举。例如验收标准的 `status` 只能是 `PROPOSED`、`APPROVED`、`IMPLEMENTED`、`VERIFIED`、`FAILED` 或 `UNKNOWN`。
3. 严格对象缺少必填字段或包含额外字段。以 `approval-response` 为例，Schema 要求决策、工作流、任务、运行、结果、时间和备注等完整字段；通用语言回答往往只给出“已批准”，不足以构成契约对象。
4. 传输中断不计入上表。Gateway 连接异常后，脚本检测到两次均为 `LLM_INVOCATION_ERROR` 时会直接中止，避免把“未获得回复”误报为 LLM 的 JSON 质量问题。

## 纠正示例

以下为根据已触发的错误码整理的 Schema 纠正示例，不是清理前失败回复的逐字副本。

### 示例 1：禁止 Markdown 包装

真实错误样例（`acceptance-criteria-01-r1` 的重写回复）：对象字段和枚举本身都有效，但整个回复以 ```` ```json ```` 开始、以 ```` ``` ```` 结束。Guard 报错为 `Unexpected token '`'`，即无法把 Markdown 围栏视为 JSON。

正确效果：只返回对象本身，例如符合 `acceptance-criteria.schema.json` 的最小结构：

```json
{
  "schema_version": 1,
  "workflow_id": "WF-account-recovery-01",
  "criteria": [
    {
      "id": "AC-001",
      "statement": "锁定账户可提交恢复申请。",
      "verification_method": "执行恢复申请接口测试。",
      "status": "PROPOSED"
    }
  ]
}
```

### 示例 2：使用 Schema 定义的枚举值

错误效果：验收标准使用 `"status": "PASS"`。`PASS` 对人类可读，但不属于该 Schema 的状态枚举，因此触发 `SCHEMA_ENUM`。

正确效果：使用契约允许的值，例如 `"status": "VERIFIED"`；若无法证实完成状态，使用保守的 `"status": "PROPOSED"` 或 `"UNKNOWN"`。

### 示例 3：严格审批对象必须完整

错误效果：

```json
{"approved": true, "reason": "同意退款"}
```

该对象缺少 `decision_id`、`workflow_id`、`task_id`、`run_id`、`outcome`、`chosen_option_id`、`decided_at` 等必填字段，且 `approved`、`reason` 不被严格 Schema 接受。

正确效果：

```json
{
  "schema_version": 1,
  "decision_id": "DEC-refund-approval-01",
  "workflow_id": "WF-refund-approval-01",
  "task_id": "TASK-refund-approval-01",
  "run_id": "RUN-refund-approval-01",
  "outcome": "APPROVED",
  "chosen_option_id": "approve",
  "raw_user_reply_summary": "批准该笔例外退款。",
  "decided_by": "杭州支付运营",
  "decided_at": "2026-07-31T09:30:00Z",
  "notes": "仅适用于本次退款审批。"
}
```

## 完整测试命令

在项目根目录执行：

```powershell
# 1. 安装锁定依赖（首次或依赖目录缺失时）
npm ci

# 2. 验证测试规划、失败包和单 Gateway 客户端状态机
npm run test:agent-json:offline

# 3. 验证全部 Schema 与模板
node scripts/runtime-guard.mjs self-check --project-root .

# 4. 执行完整缩减矩阵：19 场景 × 5 案例 × 2 独立轮次 = 190 次首轮调用
npm run agent-json:real -- `
  --run-id llm-gateway-full-<YYYYMMDD-HHMM> `
  --concurrency 4 `
  --connection-batch-size 40 `
  --repetitions 2 `
  --timeout-seconds 120
```

成功完成后，查看且只查看下列由脚本生成的内容：

```text
artifacts/agent-llm-json/llm-gateway-full-<YYYYMMDD-HHMM>/summary.json
artifacts/agent-llm-json/llm-gateway-full-<YYYYMMDD-HHMM>/report.md
artifacts/agent-llm-json/llm-gateway-full-<YYYYMMDD-HHMM>/failures/<scenario>__<case>/
```

## 后续执行建议

1. 保持每个场景 5 个差异化案例、独立重复 2 轮的缩减矩阵。
2. 在 Gateway 稳定后重新执行完整 190 用例，并保留脚本生成的最终中文 `summary.json`、`report.md` 和失败包。
3. 在提示中继续强调“最终回复必须是唯一 JSON/JSONL”，并将 Schema 的 enum、required、additionalProperties 约束优先呈现给 Agent。
