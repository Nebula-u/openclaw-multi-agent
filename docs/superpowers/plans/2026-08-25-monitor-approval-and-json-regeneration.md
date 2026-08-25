# Monitor 人工审批与同 Session JSON 重生成实施计划

> 面向实施 Agent：按任务逐项执行。功能修改遵循测试驱动开发，完成后执行整体验证和代码复审。

## 目标

1. 优化 Monitor 人工审批界面，清晰保留“确认 / 拒绝 / 其他”三个入口。
2. Agent JSON 产物出现字段缺失、类型、枚举、格式或身份字段错误时，在原 OpenClaw Session、原任务尝试和原工作树内最多重生成两次 JSON，不重新执行业务任务。
3. 完整任务三次尝试耗尽后生成绑定人工审批；用户既可在 Monitor 操作，也可在原 Manager 对话中明确授权后由 Manager 转交。
4. 所有前端入口只提交后端声明的审批选项，不能绕过 Orchestrator 或直接改写数据库。

## 总体设计

Monitor 继续作为本地、只入队的控制界面：浏览器把服务器原始 `option_id` 提交到 `/api/approvals/resolve`，等待 Orchestrator 处理并显示回执。Monitor 不持有数据库写权限，也不构造新的审批含义。

Orchestrator 将 JSON 产物修复和完整任务重试拆成两级预算：

```text
Agent 初次执行
  -> JSON 产物校验失败
  -> 原 Session JSON 重生成 #1
  -> 仍失败则原 Session JSON 重生成 #2
  -> 仍失败才结束本次任务尝试
  -> 新任务尝试使用新 Session / 新工作树
  -> 完整任务尝试预算耗尽
  -> 创建 TASK_RETRY_EXHAUSTED 人工审批
```

JSON 重生成提示由代码固定模板生成，只包含规范化和限长处理后的错误事实，例如缺失字段、字段路径、期望类型、允许枚举、格式约束和预期上下文清单哈希。修复回合禁止调用工具、修改代码、重新测试或收集证据；Agent 只在最终回复中返回完整 JSON，由宿主原子写回 raw 产物路径。

## 全局约束

- Monitor 不得直接修改 SQLite，只能排队提交审批命令。
- Manager 状态查询和审批转交继续绑定原 Manager Session。
- Monitor 至少展示“确认”“拒绝”“其他”；实际提交值必须来自待审批对象的 `request.options[]`。
- JSON 重生成必须复用同一 `sessionId`、task attempt、worktree、input manifest、artifact root 和 execution lease。
- JSON 修复预算固定为初次响应后的 2 次，且不消耗 `maxAttempts`。
- 完整任务重试使用新的 attempt、Session、context manifest 和工作树。
- 每份无效 raw、规范化诊断和修复提示按 attempt/regeneration 隔离归档。
- 修复提示不得包含模型 reasoning、未经处理的 actual 值、秘密或无关文件内容。
- 修复回合不得改变工作树；HEAD 或 status 指纹变化时必须拒绝产物。
- 完整任务重试预算耗尽后不得产生无审批的裸 HOLD。
- Manager 不得自行重置重试次数；只有用户明确确认后才能提交 `RETRY_SAME_AGENT`。
- 修改 Agent workspace/common 后，最终交付必须提醒更新已安装 Agent。

## 文件范围

| 文件 | 职责 |
| --- | --- |
| `scripts/agent-json-harness/json-repair-prompts.mjs` | 根据结构化诊断生成固定 JSON 修复提示。 |
| `scripts/orchestrator/json-regeneration.mjs` | 判断可修复错误并归档被拒绝产物、诊断和提示。 |
| `scripts/orchestrator/service.mjs` | 在原 Session 和 lease 内执行修复循环，并处理完整重试耗尽审批。 |
| `scripts/orchestrator/openclaw-runner.mjs` | 支持同一 Session 多次调用和结构化 stdout。 |
| `scripts/orchestrator/git-worktree.mjs` | 生成工作树 HEAD/status 指纹。 |
| `scripts/control-kernel/workflow-repository.mjs` | 持久化修复次数、执行轮次和尝试上限。 |
| `monitor/ui/app.js`、`approval.css`、`index.html` | 展示三类审批操作并显示提交回执。 |
| `agents/common/CONTEXT_PROTOCOL.md`、worker `AGENTS.md` | 定义初次结果和 JSON 重生成协议。 |
| Manager `AGENTS.md` | 定义重试耗尽后的用户确认和审批转交边界。 |
| `docs/human-approval.md`、`docs/manager-orchestration.md` | 说明双入口审批及两级重试预算。 |

## 任务一：固定 JSON 修复提示和错误分类

涉及文件：`json-repair-prompts.mjs`、`json-regeneration.mjs`、`agent-llm-json-harness.test.mjs`。

- [x] 先覆盖 required、type、enum、pattern、无效 JSON 和上下文哈希不一致。
- [x] 将 Ajv 和身份校验错误规范化为有限、可审计的错误事实。
- [x] required 错误明确 `missingProperty`；其他错误明确字段路径和期望约束。
- [x] 固定提示说明“这是 JSON 产物修复，不是任务重做”，禁止工具调用和业务重做。
- [x] 要求 `artifact_manifest_hash` 精确等于本次 `context_manifest_sha256`。
- [x] 只允许输出一个完整 JSON 对象，不允许补丁、解释或 Markdown 代码块。
- [x] 缺失、解析、schema、身份和上下文哈希错误可重生成；进程、路径安全、lease 和快照错误走完整任务重试。

验证：`node --test tests/agent-llm-json-harness.test.mjs`

## 任务二：持久化和审计同 Session 重生成

涉及文件：`workflow-repository.mjs`、`json-regeneration.mjs`、仓储及重生成测试。

- [x] task 映射并更新 `jsonRegenerations`、`executionRound`、`maxAttempts`。
- [x] JSON 重生成只增加 `jsonRegenerations`，不增加 task `attempt`。
- [x] 每次修复前按以下结构归档：

```text
.orchestrator/json-regenerations/attempt-N/regeneration-N/
  rejected-result.json.raw
  diagnostic.json
  repair-message.md
```

- [x] 最后一次仍失败时另存 `regeneration-exhausted/`，避免覆盖前一轮证据。
- [x] diagnostic 记录错误代码、规范化错误、raw SHA-256、Session、attempt、regeneration 和时间。
- [x] raw 不是普通文件或是符号链接时不得读取内容。
- [x] 限制诊断数量、字段长度和枚举项数量，并移除不可信 actual 值。

验证：`node --test tests/control-kernel-sqlite-repository.test.mjs tests/orchestrator-json-regeneration.test.mjs`

## 任务三：实现原 Session JSON 重生成循环

涉及文件：`service.mjs`、`openclaw-runner.mjs`、`git-worktree.mjs` 和相应测试。

- [x] 初次产物失败后，最多两次用原 `sessionId` 调用同一 Agent。
- [x] 修复回合复用原 attempt、worktree、artifact root、context manifest 和 execution lease。
- [x] 每次修复前后核验 lease，lease 丢失立即中止。
- [x] 首次修复前记录工作树 HEAD/status 指纹；接纳响应前重新比对。
- [x] 工作树变化时以 `JSON_REPAIR_WORKTREE_CHANGED` 失败，不能接纳 JSON。
- [x] 从 OpenClaw `--json` stdout 的 `finalAssistantVisibleText` 或文本 payload 提取最终 JSON。
- [x] 宿主原子写回 raw 文件，再执行既有 ingestion 校验。
- [x] 两次修复失败后才结束本次 attempt；下个 tick 才创建新 attempt、Session 和工作树。
- [x] 事件只含 task、attempt、regeneration、上限、Session、错误代码和紧凑诊断，不暴露 raw。

验证：`node --test --test-concurrency=1 tests/orchestrator-json-regeneration.test.mjs tests/orchestrator-openclaw-runner.test.mjs tests/orchestrator-lease-heartbeat.test.mjs`

## 任务四：让 worker 初次产物符合契约

涉及文件：公共协议、六个 worker workspace 规则、runtime bundle 测试。

- [x] 初次结果必须包含 `artifact_manifest_hash`。
- [x] 该字段精确复制 `context_manifest_sha256`，格式为 64 位小写十六进制。
- [x] `JSON_REWRITE_REQUEST` 仅返回完整替换 JSON，不调用工具、不重做任务、不改变已验证事实。
- [x] runtime bundle 包含相同规则。

验证：`node --test tests/runtime-bundle.test.mjs tests/agent-llm-json-harness.test.mjs`

## 任务五：重试耗尽审批与 Manager 边界

涉及文件：`service.mjs`、Manager workspace 规则及审批测试。

- [x] 完整任务达到 `maxAttempts` 后创建 `TASK_RETRY_EXHAUSTED`，不返回裸 HOLD。
- [x] 审批声明 `RETRY_SAME_AGENT`、`ABORT`、`REWORK` 三个选项。
- [x] `RETRY_SAME_AGENT` 和耗尽时的 `REWORK` 新增 attempt，并将 `maxAttempts` 增加 3。
- [x] 新批次重置 `jsonRegenerations`，创建新 context manifest、工作树和 Session。
- [x] task payload 记录 decision、choice、notes、actor 和是否属于耗尽重试。
- [x] Manager 先查询 pending approval；只有用户明确确认后才能转交服务器选项。
- [x] Manager 不能自行派发 Agent、重置计数或绕过审批。

验证：`node --test --test-concurrency=1 tests/orchestrator-json-regeneration.test.mjs tests/orchestrator-request-and-route.test.mjs tests/orchestrator-approval-command.test.mjs tests/manager-control.test.mjs`

## 任务六：重做 Monitor 审批卡

涉及文件：`monitor/ui/app.js`、`index.html`、`approval.css` 和静态测试。

- [x] 保留用户已有的 Session 稳定渲染修改。
- [x] 将服务器选项映射到确认、拒绝、其他三个视觉组，只改变展示。
- [x] `RETRY_SAME_AGENT` 归入确认，`ABORT` 归入拒绝，`REWORK` 等进入其他。
- [x] 每个按钮只提交服务器原始 `option_id`。
- [x] 显示 decision ID、审批原因、提交中状态和命令回执 ID。
- [x] 添加高对比度卡片、绿色确认、红色拒绝、中性其他选项。
- [x] 支持键盘焦点、禁用态、窄屏单列和 reduced-motion。
- [x] 明示也可在原 Manager 对话中明确授权，由 Manager 转交相同审批。

验证：`node --test tests/monitor-static-dashboard.test.mjs tests/monitor-kernel-http.test.mjs tests/orchestrator-approval-command.test.mjs tests/manager-control.test.mjs`

## 任务七：文档、视觉检查和完整验证

- [x] 文档说明 JSON 修复预算与完整任务重试预算的区别。
- [x] 文档说明 Monitor 与 Manager 对话处理同一个 pending approval。
- [x] 文档说明重试耗尽后仍需用户确认，Manager 不能自行恢复。
- [x] 在桌面与窄屏检查审批卡、焦点顺序、展开/折叠、禁用和回执状态。
- [x] 执行完整测试和安装校验。
- [x] 执行差异格式检查和最终代码复审，处理全部严重或重要问题。

完整验证命令：

```text
npm test
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
bash scripts/validate-install.sh --runtime-root runtime
git diff --check
git status --short
git diff --stat
```

如果当前 Windows 环境没有 Bash，只报告 Windows 校验和 Linux 未执行原因，不得将未运行命令写成通过。

## 验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 缺少 `artifact_manifest_hash` | 原 Session 提示明确缺失字段和预期哈希，不创建新 attempt。 |
| 类型、枚举或格式错误 | 原 Session 提示明确字段路径和期望约束。 |
| JSON 无法解析 | 原 Session 要求一个完整替换 JSON。 |
| 修复回合改动工作树 | 拒绝结果，以 `JSON_REPAIR_WORKTREE_CHANGED` 结束本次尝试。 |
| 两次修复均失败 | 本次 attempt 才失败；下次完整重试使用新 Session 和工作树。 |
| Agent 崩溃、unsafe path 或 lease 丢失 | 不进行 JSON 修复，沿用完整失败/恢复流程。 |
| 完整重试耗尽 | 创建绑定人工审批并进入 `WAITING_HUMAN`，不存在裸 HOLD。 |
| Monitor 确认/拒绝/其他 | 只提交后端声明的相应选项，并显示排队回执。 |
| Manager 对话重试 | 只有用户明确确认后，原 Manager Session 才能转交重试。 |

## 交付要求

本次修改影响 Agent common、worker/Manager workspace 和 runtime bundle。最终回复必须先说明“需要更新已安装 Agent”，给出 Windows 与 Linux 普通更新命令，并明确普通更新不需要停止 Gateway；除非注册状态或受管理 runtime 已损坏，否则不建议完整重装。
