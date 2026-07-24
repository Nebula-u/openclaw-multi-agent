# state-and-recovery.md — 文件化状态模型与恢复

> 权威来源：`agents/manager-agent/workspace/AGENTS.md`（第 2、9 节）、`agents/common/EVIDENCE_RULES.md`（第 6 节）、`contracts/workflow.schema.json`、重构 Prompt 第十一节。
> 文档日期：2026-07-23

## 1. 本文用途

本文说明新架构的**文件化状态模型**（取代旧架构的 Python `state_store` / recovery 服务）与**恢复规则**：状态完全落在文件上，`manager-agent` 是控制层文件的唯一写入者；`manager-agent` 或 Gateway 会话中断后，新的 `manager-agent` 会话必须能**仅凭文件恢复**。聊天记录**不是**唯一状态源。

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

恢复入口。登记每个活动 workflow 的 `workflow_id`、状态摘要与其 `workflow.json` 绝对路径。新会话启动时**先读它**。

### 3.2 `workflow.json`（字段以 contract 为准）

来源 `contracts/workflow.schema.json`，`required`：`schema_version`、`workflow_id`（`^WF-`）、`status`、`target_project_root_abs`、`runtime_root_abs`、`integration_branch`、`base_commit`、`current_phase`、`created_at`、`updated_at`。
其他：`status_reason`、`current_candidate_commit`、`task_ids[]`、`pending_decision_ids[]`、`context_version`、`rules_version`。`status` 全枚举见 `workflow.md`。

### 3.3 `events.jsonl`（append-only 哈希链，SHA-256）

`manager-agent` 每次状态变化**追加**一条事件，永不改写既有行。每条至少含：`seq`、`event_id`、`timestamp`、`workflow_id`、`task_id`、`run_id`、`actor`、`event_type`、`previous_event_hash`、`payload`、`event_hash`。

哈希链规则：`event_hash = SHA-256(previous_event_hash + 规范化事件内容)`，形成 `previous_event_hash → event_hash` 链条。计算用**原生工具**（Windows `Get-FileHash -Algorithm SHA256`、POSIX `sha256sum` / `shasum -a 256`），**不引入 Python**。链断裂即视为不一致（见 §5）。

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
4. 一致性校验：
   - `events.jsonl` 哈希链完整（`previous_event_hash → event_hash` 连续）。
   - `workflow.json` 快照与最新事件一致。
   - `workflow.json` 与 Git 一致（`current_candidate_commit`、`integration_branch`、任务分支、worktree 真实存在且匹配）。
5. 发现不一致 → 置 **`HOLD`**，保留证据，向用户报告差异，等待指示；**不擅自修复**。
6. **绝不因聊天上下文丢失而丢失工作流。**

## 6. 不可变性与重做

- 已派发任务的 `input/` **不可变**；已完成 run 目录 **不可变**。
- 重做 → 新 `run_id` + 新目录（`<wf>\<task>\<新 run>\`），**不覆盖**旧报告/日志/审批/结果；旧任务按状态机置 `SUPERSEDED`。
- 失败 / 脏状态 / 未合并 / 待审批的 worktree **默认保留**，不清理（见 `git-worktree-strategy.md`）。

## 7. 相关文档

`workflow.md`（状态枚举）、`manager-orchestration.md`（写状态的时机）、`context-and-rule-passing.md`（快照与上下文摘要）、`git-worktree-strategy.md`（Git 与 worktree 一致性）、`evidence-and-claims.md`（证据与哈希）。
