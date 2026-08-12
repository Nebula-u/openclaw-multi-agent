# LLM JSON 回复清洗与重写

本文件定义所有 Agent 生成或接收 JSON/JSONL 契约时的失败处理。权威数据仍是通过 Runtime Guard + Ajv 的 artifact；会话文本只用于通知或重写。

## 处理顺序

1. 保存原始回复和 SHA-256。
2. 仅做确定性清洗：BOM、唯一 JSON/JSONL Markdown fence、唯一解释性前后缀中的完整值。
3. 保存清洗后 SHA-256 和转换记录；多个候选或无法完整解析时拒绝猜测。
4. 用对应 Schema 运行 Ajv。`enum`、`type` 单独分类；`required`、`additionalProperties`、`const`、`pattern` 等归为 schema drift。
5. 首次调用之外最多重写两次；空 content、截断、解析错误和 Schema 失败共用预算。失败链路完整保留。

不得自动“修复”业务值，也不得把 enum/type 违规改成猜测值。对模型的重写必须不改变已知事实、证据、命令结果或审批决定。

## 固定模板摘录

enum/type：

```text
JSON_REWRITE_REQUEST kind=ENUM_VIOLATION retry=1/2.
只返回一个完整的 JSON 对象（JSONL 时每行一个完整 JSON 对象）；不得输出 Markdown、代码围栏、解释或前后缀。
校验诊断：[{"path":"/result_status","schema_keyword":"enum","message":"must be equal to one of the allowed values","params":{"allowedValues":["COMPLETED","BLOCKED"]}}]
指定字段的类型或 enum 值不合法。仅修正诊断指向的字段，使其使用 Schema 中允许的类型和枚举值；其它事实保持不变。
```

截断：

```text
JSON_REWRITE_REQUEST kind=OUTPUT_TRUNCATED retry=2/2.
上一轮 JSON 在结束前截断。请从头输出一个更精简但完整、闭合的 JSON；不要续写片段，确保不超过输出预算。
```

实际模板实现位于 `scripts/agent-json-harness/json-repair-prompts.mjs`；该模块同时覆盖空 content、JSON parse error 与 schema drift。

## Provider 无关边界

项目不向模型请求附加结构化输出模式。所有模型回复都经过相同的原文留存、确定性清洗、Ajv 校验和失败证据链。空 content 是通用失败类型，不关联特定厂商；纯工具调用无文本仍是有效中间状态。
