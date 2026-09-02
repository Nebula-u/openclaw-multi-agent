# HR Agent Session 审查

## 用途和边界

HR Agent 是只读复核者，默认手动使用。它按 Agent Session 独立审查，首版只识别三类问题：

- `UNAUTHORIZED_ACTION`：动作或修改超出被分配角色/任务边界；
- `UNCLEAR_BOUNDARY`：所有权、限制、未完成项或边界没有清楚说明；
- `SPECULATIVE_OR_VAGUE`：用猜测或模糊措辞替代可核验证据。

HR 不批准任务、不推进状态、不联系用户、不派发其他 Agent，也不能自行浏览任意 Session 根目录。

## 每个 Session 的输入

Orchestrator 通过 snapshot 中的 `agent_id + session_id` 定位对应 OpenClaw JSONL，并生成脱敏 dossier。只包含：

- assistant `thinking`/`reasoning` 块；
- 最后一条 assistant 可见输出；
- snapshot 的 input/output commit、类型和宿主计算的变更摘要；
- task kind、step、标题、rationale、assigned Agent 和是否允许修改目标仓库的最小边界元数据；
- Git 文本 patch。二进制文件仍进入变更摘要/stat，但 dossier 不内联 binary patch payload。

明确排除：用户消息、system prompt、工具参数、工具输出和中间可见回复。Session ID 必须符合安全字符规则，真实文件路径必须仍位于配置的 Session 根目录内，普通文件和目录链接越界都会失败关闭。

默认上限：整个 Session 的 reasoning 共 12,000 字符、最终输出 8,000 字符、patch 40,000 字符。dossier 记录原始/保留字符数和截断状态。这样 HR 一次只处理一个 Session，不把全天所有 Agent 内容装入同一上下文。

## 手动使用

按 workflow、task 或日期选择：

```text
node scripts/orchestrator-cli.mjs hr-review --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs hr-review --project-root . --task-id TASK-...
node scripts/orchestrator-cli.mjs hr-review --project-root . --date 2026-08-21
```

`hr-review` 默认入队后立即执行。只入队：

```text
node scripts/orchestrator-cli.mjs hr-review --project-root . --task-id TASK-... --enqueue-only true
node scripts/orchestrator-cli.mjs hr-run-pending --project-root . --limit 20
```

每个 `snapshot + source Session` 生成唯一 `review_key`。手动、task 和 daily 触发共享去重键；同一份 Agent Session 不会因为换了触发方式而重复审查。`RESTORE`/`REVERT` 只引用旧 Session，不会重新排队。

`--date` 必须是有效的 `YYYY-MM-DD`，按 UTC 匹配 `snapshots.created_at` 的日期部分。非法日期会返回 `HR_REVIEW_DATE_INVALID`，不会静默得到空结果。

## 自动接口

`OPENCLAW_HR_AUTO_MODE`：

- `off`：默认，不自动排队或运行；手动 `hr-review`/`hr-run-pending` 仍可用；
- `task`：任务完成/失败后自动按其 snapshot 排队，前台 Orchestrator 处理队列；
- `daily`：允许外部调度器调用 daily 命令；
- `both`：同时启用 task 与 daily。

daily 入口：

```text
node scripts/orchestrator-cli.mjs hr-review-daily --project-root . --date 2026-08-21
```

项目不自行安装 cron、systemd timer 或 Windows Task Scheduler 条目。`daily`/`both` 只是保留可调度接口；运维方决定具体时间。

## 隐私和失败处理

- dossier 在交给 HR 前脱敏；HR 自己的原始 Session 不通过 Monitor 展示；
- finding 只应引用最短必要的脱敏片段，不复述完整 private reasoning；
- OpenClaw `--json` 外层 envelope 和 HR 文本结果都会严格解析。结果只能包含三类 category，severity 只能为 `INFO/LOW/MEDIUM/HIGH/CRITICAL`，每条 finding 必须包含证据定位、最短脱敏摘录、解释和建议；
- Monitor 只展示通过上述校验并写入 SQLite 的结构化 findings，不读取 HR Session 原始输出；
- Session 缺失、路径越界或 Git diff 不可用时，该 review 不应伪造结论；
- HR 执行失败或结构非法会把该 job 标为 `FAILED` 并写 `hr_jobs.last_error`，不会改变原 workflow/task 结果；
- HR 自身以 `thinking=off` 运行，避免产生新的待审私有推理链。
