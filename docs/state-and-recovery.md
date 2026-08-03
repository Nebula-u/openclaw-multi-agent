# state-and-recovery.md — 文件化状态模型与恢复

> 权威来源：`agents/manager-agent/workspace/AGENTS.md`（第 2、9 节）、`agents/common/EVIDENCE_RULES.md`（第 6 节）、`contracts/workflow.schema.json`、重构 Prompt 第十一节。
> 文档日期：2026-07-29

## 1. 本文用途

本文说明新架构的**文件化状态模型**（取代旧架构的 Python `state_store` / recovery 服务）与**恢复规则**：状态完全落在文件上，`manager-agent` 是控制层文件的唯一写入者；`manager-agent` 或 Gateway 会话中断后，新的 `manager-agent` 会话必须能**仅凭文件恢复**。Runtime Guard 只校验或追加事件，不维护快照、不调度任务。聊天记录**不是**唯一状态源。

## 2. 唯一事实来源

- 用户原始需求：`<workflow>\user-request.md`
- 结构化工作流文件：`workflow.json`、`events.jsonl`、`context-summary.md`、`rules-snapshot.md`、`tasks/`、`decisions/`、`gates/`
- 任务上下文包：`<artifact_run>\input\`
- Agent 结构化结果与原始报告：`<artifact_run>\output\`
- 本地 Git commit / diff / worktree
- 原始命令日志与哈希（`raw-logs/`、`checksums.sha256`）

## 3. 文件化状态模型

绝对路径示例基于 `runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime`：

```text
<runtime_root_abs>\control\
├── active-workflows.json         # 恢复索引：登记所有活动 workflow
├── install-manifest.json         # runtime_root_abs、7 Agent 绝对路径、配置变更、校验结果
├── config-snapshots\             # 安装时的 OpenClaw 配置备份
└── workflows\<workflow-id>\
    ├── workflow.json             # 工作流当前快照
    ├── user-request.md
    ├── context-summary.md        # 逐阶段裁剪后的上下文摘要
    ├── rules-snapshot.md         # 固化规则版本与哈希
    ├── events.jsonl              # append-only 事件哈希链（SHA-256）
    ├── tasks\<task-id>.json
    ├── decisions\<dec-id>.request.json / <dec-id>.response.json
    ├── gates\<phase>-<n>.json
    └── final-report.md
```

### 3.1 `active-workflows.json`

恢复入口。只登记非终态 workflow 的 `workflow_id`、状态摘要与其 `workflow.json` 绝对路径。新会话启动时**先读它**；workflow 进入终态后必须先写非空 `final-report.md`，再从活动索引移除，Guard 要求终态恰好有 0 条活动记录。

### 3.2 `workflow.json`（字段以 contract 为准）

来源 `contracts/workflow.schema.json`，`required` 包括：`schema_version`、`workflow_id`（`^WF-`）、`status`、`status_reason`、`target_project_root_abs`、`runtime_root_abs`、`integration_branch`、`base_commit`、`current_candidate_commit`、`current_phase`、`state_revision`、`task_ids[]`、`pending_decision_ids[]`、`context_version`、`rules_version`、`rules_snapshot_sha256`、`context_summary_sha256`、`created_at`、`updated_at`。`status` 全枚举和合法迁移见 `workflow.md` 与状态机。

### 3.3 `events.jsonl`（append-only 哈希链，SHA-256）

`events.jsonl` 是 JSONL 的 append-only 哈希链。manager 每次状态变化创建事件草稿；`append-event` 写入 `schema_version=1`、连续的 `seq` 和 `state_revision`、前一行的 `previous_event_hash`（首行是 64 个 `0`），并在 fsync 后追加，既有行永不改写。每条事件还含 `event_id`、`timestamp`、`workflow_id`、`task_id`、`run_id`、`actor`、`event_type`、状态/阶段前后值、候选 commit、`payload` 与 `event_hash`。

哈希规则：移除 `event_hash` 后，递归按 Unicode 码点排序 JSON 对象键（数组顺序不变），直接序列化排序后的键值对，将 canonical JSON 用 UTF-8 编码并计算 SHA-256。数字形态的键仍按字符串排序，例如 `"10"` 必须位于 `"2"` 之前，且嵌套对象遵守同一规则；不得先构造普通 JavaScript 对象再依赖 `JSON.stringify` 的整数键重排。`previous_event_hash → event_hash` 形成连续链；第 *n* 条的 `seq` 和 `state_revision` 均为 *n*。最新事件的 `to_status`、`to_phase`、`candidate_commit` 与 `state_revision` 必须分别等于 `workflow.json` 的 `status`、`current_phase`、`current_candidate_commit` 与 `state_revision`；非终态的 `active-workflows.json` 同名快照字段再与 workflow 一致。

### 3.4 `context-summary.md` / `rules-snapshot.md` / `decisions` / `gates`

- `context-summary.md`：每阶段结束更新，只保留后续阶段需要的事实/决策/限制/证据引用（最小充分）。
- `rules-snapshot.md`：固化当前规则版本与哈希；改规则须新建快照，不改已派发 input（见 `context-and-rule-passing.md`）。
- `decisions/`：`approval-request.schema.json` / `approval-response.schema.json` 文件。
- `gates/`：`gate-result.schema.json` 文件。

## 4. ID 规范

所有 workflow / task / run / decision / finding / evidence 均有唯一 ID：

```text
WF-<UUID> · TASK-<UUID> · RUN-<UUID> · DEC-<UUID> · FIND-<UUID> · EVD-<UUID>
```

- contracts 中以正则约束前缀（如 `workflow_id` 的 `^WF-`、`task_id` 的 `^TASK-`、`run_id` 的 `^RUN-`、`decision_id` 的 `^DEC-`、`finding_id` 的 `^FIND-`、`evidence_id` 的 `^EVD-`）。
- UUID 用 **OpenClaw 自身能力或 OS 原生能力**生成：
  - Windows：`pwsh -NoProfile -Command "[guid]::NewGuid().Guid"`
  - POSIX：`uuidgen` 或读 `/proc/sys/kernel/random/uuid`
- **不得**为生成 ID 引入 Python 脚本或 Python 控制平面。

## 5. 恢复算法（新 manager 会话启动时）

1. 读 `<runtime_root_abs>\control\active-workflows.json`。
2. **恰好一个**活动 workflow → 读其 `workflow.json`、`events.jsonl`、`context-summary.md`、未决 `decisions/`、Git 状态后恢复。
3. **多个**活动 workflow → **让用户选择**，不擅自挑选。
4. 运行 `recovery-check --project-root <project> --runtime-root <runtime> [--workflow-id <WF-...>]`。未指定 ID 时仅允许恰好一个活动 workflow；该命令执行完整 `check-workflow` 校验，涵盖事件链、状态机迁移、最新快照、任务/结果、审批、Gate 与 Git 候选 commit。
5. Guard 失败或发现不一致 → manager 将 workflow 按合法迁移置 **`HOLD`**（Guard 本身不写快照），保留证据，向用户报告差异，等待指示；**不擅自修复**。
6. **绝不因聊天上下文丢失而丢失工作流。**

## 6. 不可变性与重做

- 已派发任务的 `input/` **不可变**；已完成 run 目录 **不可变**。
- 重做 → 新 `run_id` + 新目录（`<wf>\<task>\<新 run>\`），**不覆盖**旧报告/日志/审批/结果；旧任务按状态机置 `SUPERSEDED`。
- 历史 review/release artifact 保留不覆盖。Guard 只让 current candidate 的 review finding 参与阻断，并按可信 task event `seq` 处理 finding closure；ReviewGate/SecurityGate 的 PASS 必须引用 current candidate 的合法 review 证据。ReleaseReadinessGate 只消费其 `task_id` 当前 task snapshot 所指 `run_id` 的唯一 release decision；历史 release gate/decision 只做自身一致性校验，不参与当前候选或终态裁决，同 candidate 的旧 release rerun 也不覆盖最新 release task/run。release 终态缺少最新 release task/run gate 时必须 fail-closed。
- 失败 / 脏状态 / 未合并 / 待审批的 worktree **默认保留**，不清理（见 `git-worktree-strategy.md`）。

## 7. 相关文档

`workflow.md`（状态枚举）、`manager-orchestration.md`（写状态的时机）、`context-and-rule-passing.md`（快照与上下文摘要）、`git-worktree-strategy.md`（Git 与 worktree 一致性）、`evidence-and-claims.md`（证据与哈希）。
