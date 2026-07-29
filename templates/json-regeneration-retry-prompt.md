# JSON Regeneration Retry Prompt

The JSON or JSONL artifact below failed schema validation.

You must regenerate only the failed JSON/JSONL artifact. Do not redo the task analysis, do not change the existing facts, decisions, evidence, reports, code changes, command results, or conclusions. Only fix JSON structure, required fields, field types, enum values, path/reference formatting, timestamps, and schema-related syntax.

- Failed artifact: `<ABS_JSON_OR_JSONL_PATH>`
- Schema: `<ABS_SCHEMA_PATH>`
- Validation error log: `<ABS_JSON_VALIDATION_ERRORS_JSONL>`
- Retry count: `1`

Use the already completed analysis and existing surrounding artifacts as the source of truth. If a required value cannot be recovered from existing artifacts, set the most conservative schema-valid value allowed by the contract and record the limitation in `unresolved_issues` or the relevant existing issue field. Do not invent command results, evidence IDs, file hashes, commits, or approval decisions.
