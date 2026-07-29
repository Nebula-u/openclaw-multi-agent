# Trusted Runtime Guard Design

## Goal

为文件协议驱动的 OpenClaw 多 Agent 工作流增加一个轻量、确定性、失败关闭的运行时校验边界，使状态迁移、Agent JSON 产物、事件链、Gate 和人工审批能够被机器复核，而不是仅依赖 manager-agent 遵守散文提示。

## Constraints

- 不恢复 Python 控制平面，不新增 daemon、dispatcher、后台服务或网络依赖。
- 不替代 manager-agent 的编排职责，不直接调用或包装 `sessions_spawn`。
- 运行时只依赖 OpenClaw 已经使用的 Node.js 标准库，不新增 npm 依赖。
- 不自动修复损坏的历史状态；发现不一致时退出非零并形成有效 HOLD。
- 保持当前 12 份第一周 Agent 契约兼容，只对控制层和缺失的关键语义做定向收紧。
- 当前环境没有历史 `runtime/`，因此历史 Windows Demo 仅支持后续只读审计，不自动迁移。

## Architecture

新增 `scripts/runtime-guard.mjs`，它是无状态、按需执行的验证工具，不是控制平面。它提供三个命令：

1. `validate-file`：按仓库 JSON Schema 验证 JSON 或逐行 JSONL。
2. `append-event`：读取事件草稿，补齐连续序号、前序哈希和事件哈希后 append 一行。
3. `check-workflow`：对活动索引、workflow、tasks、events、results、evidence、command records、gates、approvals、review findings、release decision 和 Git candidate 做跨文件一致性检查。

所有命令以 JSON 输出结果。成功退出码为 `0`；任何解析、Schema 或语义错误退出码为 `1`。manager-agent 在 spawn、merge、阶段推进、恢复和完成声明前必须获得 `check-workflow` 的成功结果。失败本身即为有效 HOLD；Guard 不覆盖历史制品。

## State Model

`config/workflow-state-machine.json` 是任务和工作流合法迁移的机器权威来源。`workflow.json` 与 `active-workflows.json` 增加 `state_revision`。每条 workflow event 的 `seq`、`state_revision` 连续递增，最新事件必须与 workflow 的状态、阶段、候选提交和 revision 一致。

工作流增加两个通用状态：

- `WAITING_HUMAN`：不属于需求、架构、发布三个专用等待点的人工审批。
- `HOLD`：控制状态、事件链、证据或环境不可信时的通用冻结状态。

现有三个专用等待状态与 `RELEASE_HOLD` 保留，以避免无必要的语义迁移。

## Event Integrity

事件由 Guard 统一追加。规范化规则为：

- 对象键递归按 Unicode 码点排序；数组顺序保持不变。
- 使用无缩进、无额外空白的 JSON UTF-8 字节，不写 BOM。
- 哈希输入为不含 `event_hash` 的完整规范化事件对象；`previous_event_hash` 已包含在对象中，不重复拼接。
- 第一条事件的 `previous_event_hash` 为 64 个字符 `0`。
- `event_hash` 为 SHA-256 小写十六进制。

事件可同时携带 workflow 与 task 状态迁移。最新 task event 必须与控制层 task 快照一致。

## Schema Validation

Guard 实现仓库现有契约实际使用的 Draft-07 子集：`type`、`required`、`properties`、`additionalProperties`、`items`、`enum`、`const`、`minimum`、`minLength`、`minItems`、`pattern`、`format: date-time` 和本地 `$ref`。

不支持的 Schema keyword 会使静态验证失败，避免把未知约束静默忽略。运行产物中残留 `<PLACEHOLDER:` 会被拒绝；模板静态验证可显式允许 placeholder。

新增两份缺失的控制层契约：

- `contracts/active-workflows.schema.json`
- `contracts/workflow-event.schema.json`

## Gate Semantics

每个 Gate item 增加必填 `blocking`：

- 任一 item 为 `FAIL`，`overall` 必须为 `FAIL`。
- 无 FAIL，但存在 `HOLD`，或阻断 item 为 `UNKNOWN`，`overall` 必须为 `HOLD`。
- 其他情况才允许 `PASS`。
- `overall_reason` 必填。
- 存在未关闭审批时，任何 Gate 不得为 PASS。
- Review/Security/Release Gate 面对未关闭的 BLOCKER、CRITICAL、HIGH finding 时不得为 PASS。
- ReleaseReadinessGate 的 overall 必须与 release verdict 一致。

## Approval Semantics

approval request/response 都显式包含可空的 `task_id` 与 `run_id`，响应必须与申请逐字段匹配。APPROVED/MODIFIED 必须选择申请中真实存在的 option；REJECTED 不得放行操作。

`workflow.pending_decision_ids` 必须与所有 PENDING request 精确一致。存在 PENDING request 时，workflow 必须处于对应专用等待状态、`WAITING_HUMAN`、`HOLD` 或 `RELEASE_HOLD`。

## Templates

增加 active index、event、gate、approval request/response 模板。现有 workflow、task、result 模板改为安全默认值：空审批依赖、非成功结果、无伪造 OBSERVED claim。模板仍包含明显 placeholder 供人工填充，但 runtime Guard 会拒绝未替换的 placeholder。

## Verification

使用 Node 内置 `node:test` 和真实临时文件，不使用 mocks。覆盖非法 JSON、缺字段、非法迁移、revision 不一致、事件断链/篡改、错误 Gate 聚合、审批跨作用域复用、高风险 finding 放行、release verdict 冲突和合法 happy path。

安装静态验证脚本将调用 Guard 验证全部 Schema、模板和内置测试。Linux 当前环境执行 Bash 和 Node 验证；PowerShell 逻辑接受静态审查，但只有在提供 `pwsh` 的环境中才能实际执行。

## Documentation Outcome

README 只描述最终能力、命令和边界。CHANGELOG 记录改了什么、为什么改以及改后的效果。架构、工作流、恢复、Gate 和审批文档修正为与机器契约一致。

