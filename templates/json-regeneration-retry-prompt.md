# JSON 重写提示

下方 JSON 或 JSONL 产物未通过 Schema 校验。若上一轮模型输出为空，先按 `EMPTY_LLM_OUTPUT` 规则在同一会话最多重试 3 次；本模板仅用于获得非空回复后的 Schema 重写，且只允许一次。

你只能重新生成这个失败的 JSON/JSONL 产物。不得重新分析任务，不得变更既有事实、决策、证据、报告、代码改动、命令结果或结论。只能修正 JSON 结构、必填字段、字段类型、枚举值、路径/引用格式、时间戳和与 Schema 相关的语法。

- 失败产物：`<ABS_JSON_OR_JSONL_PATH>`
- Schema：`<ABS_SCHEMA_PATH>`
- 校验错误日志：`<ABS_JSON_VALIDATION_ERRORS_JSONL>`
- 重写次数：`1`

以已完成的分析和已有周边产物为事实来源。若不能从已有产物恢复某个必填值，使用契约允许的最保守且 Schema 有效的值，并在 `unresolved_issues` 或相应的现有问题字段记录限制。不得编造命令结果、证据 ID、文件哈希、提交或审批决定。
