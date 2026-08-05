# manager-orchestration.md — manager-agent 原生调度算法

> **v2 提示（2026-08-05）：** Agent 职责和 OpenClaw 原生调度算法保持有效；本文涉及可写 workflow/task/active JSON、`commit-transition` 和文件型 dispatch 的步骤仅适用于遗留 v1。新 workflow 必须使用 [control-kernel-v2.md](control-kernel-v2.md) 的命令与 outbox 顺序。

> `manager-agent` 是**唯一工作流总控**，默认唯一与用户交流者。
> 权威来源：`agents/manager-agent/workspace/AGENTS.md`、`TOOLS.md` 与重构 Prompt 第十节。
> 文档日期：2026-07-23

## 1. 本文用途

本文给出 `manager-agent` 的**原生调度算法**（编号步骤），说明它如何在**不运行任何本项目 Python 脚本**、**不启动独立控制平面**的前提下，仅凭文件协议 + OpenClaw 原生工具完成：接收请求 → 保存原始需求 → 建立 ID 与工作流文件 → 生成任务上下文包 → 用原生会话工具 `sessions_spawn(agentId)` 派发 → 原生 yield/wait 等待 → **实际校验**结果 → Gate → 向用户转述 → 决定继续/打回/暂停/恢复/审批。Runtime Guard 是无状态 Node.js 边界校验器，不是 daemon、dispatcher 或第二控制平面；manager 仍是唯一编排者和控制文件写入者。文末给出 `manager-agent` 的**禁止清单**。

## 2. 运行时定位（绝对路径，System32 防护）

`manager-agent` 依据 `install-manifest.json` 中的 `runtime_root_abs` 定位一切，**绝不依赖当前工作目录**——即使从 `C:\Windows\System32` 启动也是如此。下文示例假定：

```text
runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime
control          = <runtime_root_abs>\control
worktrees        = <runtime_root_abs>\worktrees
artifacts        = <runtime_root_abs>\artifacts
```

## 3. INTAKE 算法（收到用户请求）

1. 先生成 `WF-<UUID>`，再新建 workflow 目录；把用户原始消息保存到 `<control>\workflows\<workflow-id>\user-request.md`。
2. 解析并**规范化**目标业务项目路径为绝对路径；验证目录存在。非绝对或不存在 → 向用户澄清（不猜测）。
3. 探测目标仓库 Git 状态：`git -C "<target_abs>" status --porcelain=v2 --branch`；记录 base commit `git -C "<target_abs>" rev-parse HEAD`。
   - 目标**不是** Git 仓库 → **不** `git init`，生成 approval-request（trigger `INPUT_NOT_GIT_REPO`）。
   - 存在**未提交修改** → **不**自动 commit/stash/丢弃/reset，生成 approval-request（trigger `INPUT_DIRTY_WORKTREE`）。
4. 读取 policy（`config/default-policy.yaml` + 项目覆盖）与实际隔离模式（本阶段固定 `UNSANDBOXED_LOCAL`）。
5. 写 `workflow.json`（`status=CREATED`）；初始化 `events.jsonl`（append-only 哈希链）；写 `rules-snapshot.md`（固化当前规则版本与哈希）。
6. 在 `<control>\active-workflows.json` 登记该 workflow。
7. 创建 integration 分支 `sdlc/<workflow-id>/integration`（基于 base commit）。
8. 生成第一个任务（requirement task）及其上下文包（见第 4 节）。

## 4. 派发一个任务的算法（各阶段任务通用）

### 4.1 生产代码与大型前端拆分

生产代码、HTML、CSS、JavaScript、前端资源和构建配置只能由 `developer-agent` 在正式 task 的 worktree 中修改；manager 不得直接调用文件或 Shell 工具实现这些内容。任何预计超过约 3,000 输出 token 的单文件实现，或同时包含页面结构、样式和交互的前端需求，必须建立相互依赖的 developer task：

| 顺序 | task 类型 | 允许的主要产物 | 依赖 |
| --- | --- | --- | --- |
| 1 | `frontend_scaffold` | 页面骨架、入口、空容器 | 无 |
| 2 | `frontend_styles` | CSS 变量、布局、响应式、视觉样式 | 1 |
| 3 | `frontend_components` | HTML 主体组件和内容区块 | 1、2 |
| 4 | `frontend_interactions` | JavaScript 交互、状态、导出逻辑 | 1、3 |
| 5 | `frontend_verify` | 真实构建/静态/浏览器检查及最小修复 | 1–4 |

每个 task 的 acceptance criteria 必须限定文件或区块、`allowed_write_paths_abs`、`forbidden_paths_abs` 和实际验证命令。派发提示应要求 developer 直接编辑 worktree、不要在聊天回复中展开完整源码；单次编辑保持约 4,000–6,000 输出 token，需要时做多次增量编辑。依赖 task 必须先完成既有 artifact、commit、Gate 验证并合入 integration，后续 task 才能使用其 candidate commit。

1. 生成 `TASK-<UUID>`、`RUN-<UUID>` 与 `attempt`；写 `tasks/<task-id>.json`（见 `contracts/task.schema.json`），`status` 由 `CREATED` → `READY`。
2. 若为 `developer` / `test` 类任务：从**允许的 input commit** 创建任务分支与**绝对** worktree：
   ```text
   git -C "<target_abs>" worktree add -b sdlc/<wf>/<task>/<agent>/attempt-<n> \
       "<runtime_root_abs>\worktrees\<wf>\<task>\<run>\repo" <input_commit>
   ```
   仅在该 worktree 对应仓库设置**本地** Git identity（不改全局）。
3. 组装任务上下文包到 `<artifact_run>\input\`（见 `context-and-rule-passing.md` 与 `CONTEXT_PROTOCOL.md`）：`task.json`、`context.md`、`rules.md`、`acceptance-criteria.json`、`approved-decisions.json`、`source-manifest.json`、`context-manifest.json`；为每个 input 文件计算 SHA-256 写入 `context-manifest.json.input_files[]`。
4. 只传**最小充分**上下文：**不**复制用户完整聊天历史；**不**要求工作 Agent 读 manager 会话历史。
5. 用 OpenClaw 原生会话工具创建**隔离**的工作 Agent 会话：
   - 若本版本提供 `sessions_spawn`：调用时**必须显式传 `agentId`**，且 `agentId == task.assigned_agent`；上下文语义用 `isolated`。
   - 若工具名/参数不同：以真实工具 schema 为准调整，并在 `docs/compatibility-report.md` 记录差异。**不得**退回相对路径，**不得**引入 Python 脚本。
6. 派发提示只含：任务摘要、绝对 `context-manifest.json` 路径、绝对 `task.json` 路径、绝对输出目录、绝对 worktree 路径。
7. `task.status` → `DISPATCHED` → `RUNNING`；append event；保存子会话 session/run 标识与完成公告引用。
8. 用 OpenClaw 原生 **yield / wait / 完成通知**机制等待；**不用 `sleep`、不高频轮询**。
9. 在 spawn 前以 `check-task-package` 校验任务、上下文和结构化输出声明；校验失败即停止派发，并写入 `<workflow>/validation-errors.jsonl`。每次任务或工作流状态变化都必须由 `commit-transition` 同时提交 event、workflow、active index 与可选 task；`append-event` 不得用于新流程推进。阶段/合并边界再以 `check-workflow` 复核。

## 5. 验证工作 Agent 返回（任何改动类任务，编号即必检项）

Agent 返回后，`manager-agent` **必须实际检查**以下各项，**任一失败即不继续**：

1. `output/result.json` 可解析且 schema 合法（见 `contracts/result.schema.json`），所有工作 Agent 声明的 JSON / JSONL 输出也必须按对应 contract 再校验一次。
2. `workflow_id` / `task_id` / `run_id` 与当前任务一致。
3. `result.json.agent_id == task.assigned_agent`。
4. 声明的 output / report 文件真实存在。
5. 引用的日志（`command-records.jsonl`、`raw-logs/`）真实存在。
6. Git commit 真实存在：`git -C "<worktree>" cat-file -t <output_commit>`。
7. commit 基于允许的 input commit（ancestry）：`git -C "<worktree>" merge-base --is-ancestor <input_commit> <output_commit>`。
8. 分支与 worktree 与 `task.json` 一致。
9. 修改范围符合角色权限：`git -C "<worktree>" diff --name-only <input_commit> <output_commit>`，diff 路径落在 `allowed_write_paths_abs` 内，不触碰 `forbidden_paths_abs`。
10. worktree 状态符合要求（如需干净：`git -C "<worktree>" status --porcelain`）。
11. 文件哈希与 `checksums.sha256` 一致。
12. 无明显凭证泄露（扫描 result/report/日志的敏感模式）。

JSON / JSONL 校验失败 → 这是阻断错误，不得将 `claims`、`self_validation`、`unresolved_issues` 或 `isolation_mode` 视作“附加元数据”而放行。首次调用外最多两次 JSON-only retry：manager 按空输出、截断、enum/type 或 schema drift 的固定模板明确要求工作 Agent 只重新生成失败 JSON / JSONL 文件，不重新完整分析，不改变既有事实、证据、报告、代码、命令结果或审批判断；每次重写提示、原始/清洗哈希、scope、retry_count 和错误均保存到该 run 的 `raw-logs/` 或 `<workflow>/validation-errors.jsonl`。

验证失败或重试仍失败 → **不继续**；任务按合法任务状态进入 `NEEDS_REWORK`、`FAILED`、`BLOCKED` 或 `WAITING_HUMAN`，workflow 视情形进入 `HOLD`，再 append event，按第 7 节决策。**不得**把 `HOLD` 写入 `result_status`，也不得因 Agent 回复"已完成"就跳过上述校验。

## 6. Gate 与阶段推进

- 每阶段结束按 `docs/gate-checklists.md` 的**版本化检查清单**逐项写 `gates/<phase>-<n>.json`（见 `contracts/gate-result.schema.json`）；每项 ∈ `PASS` / `FAIL` / `HOLD` / `UNKNOWN` / `NOT_APPLICABLE`，`overall ∈ PASS / FAIL / HOLD`。
- **只有 Gate 通过（无阻断项）才进入下一阶段**；**不得把 `UNKNOWN` 改写成 `PASS`**。
- Review/Security/Release Gate 的 finding authority 只取 `reviewed_commit == workflow.current_candidate_commit` 的合法 review task artifact；同 `finding_id` 以该 task 已验证的最后 event `seq` 选择唯一最新状态，旧 candidate 不阻断，歧义即 HOLD。ReviewGate/SecurityGate 的 PASS 还必须引用 current candidate 的合法 review-agent 证据。
- 每个 ReleaseReadinessGate（包括 `FAIL` / `HOLD`）必须用 `task_id` 绑定一个 `RELEASE_VERIFICATION` / `release-agent` task，并消费该 task snapshot 当前 `run_id` 下恰好一份 release decision。历史 release gate/decision 保留且只做自身一致性校验；只有 current candidate 的最新 release task/run 对应的 ReleaseReadinessGate 参与当前候选与已终态 workflow 状态裁决，同 candidate 的旧 rerun gate 也不参与。release 终态必须恰好有一个最新 release task/run gate；decision/check evidence 必须属于其绑定的 release run，verdict 与 checks、Gate overall 必须一致。
- 每个 Agent 完成后，`manager-agent` **必须**向用户显示该 Agent 的自然语言总结（`output/user-summary.md`），**标注来源角色**，并**保留其中的 `UNKNOWN` / 风险 / 限制**。
- 通过 Gate 的任务分支由 `manager-agent` 用 `--no-ff` 合并进 integration（合并前重跑第 5 节校验；conflict **不猜测**，退回对应 Agent，见 `git-worktree-strategy.md`）。
- 每阶段结束更新 `context-summary.md`，只保留后续阶段需要的事实/决策/限制/证据引用。
- 在 spawn、合并、阶段推进、恢复与宣布完成前后运行适用的 Guard 检查；任一 Guard 非零退出或 `effective_status=HOLD` 都 fail-closed：不派发、不合并、不推进、不宣布完成，直到 manager 按状态机处理并重新校验。Guard 调用必须带错误日志路径，确保校验失败主体和错误内容可追溯。

## 7. 决策、审批与状态机

- 任务状态与工作流状态的全枚举见 `workflow.md`；`result_status` 五值见 `agent-contracts.md`。
- 触发人工审批节点（`APPROVAL_RULES.md` 的 15 类之一）→ 生成 `decisions/<dec-id>.request.json`（见 `contracts/approval-request.schema.json`），工作流置 `WAITING_HUMAN`。
  - **不设自动超时同意**；用户沉默 ≠ 批准；等待期间**不调度依赖该决策的任务**。
  - 用户回复后保存 `<dec-id>.response.json`（见 `contracts/approval-response.schema.json`）+ 原始回复摘要。
- 默认最大重做次数为 **3**（policy 可改）；超过 → `WAITING_HUMAN`（trigger `MAX_REWORK_EXCEEDED`）。
- FAILURE TRIAGE 归口：生产代码缺陷→`developer-agent`；测试代码错误→`test-agent`；架构问题→`architect-agent` 再由 `developer-agent` 实现；验收标准冲突→`requirement-agent` + 人工审批；安全问题→`developer-agent` 修复、`review-agent` 复审；工具/环境缺失→`BLOCKED` 或 `HOLD`，不假装成功。

## 8. 每次动作后的完成自检

- 是否有未写入的状态变更事件？（`events.jsonl` append-only，哈希链连续）
- `workflow.json` 的 `updated_at` / `current_phase` / `current_candidate_commit` / `pending_decision_ids` 是否已同步？
- 是否已向用户转述本阶段 Agent 的原始总结并标注角色？
- 是否把 `UNKNOWN` 当 `PASS`？是否跳过 commit/diff/日志/证据校验？
- 待审批期间是否误调度了依赖任务？
- 是否已用 `check-workflow` 核对事件链、快照、索引、审批、Gate 与候选 commit？宣布完成前是否已运行 `self-check`？

任一不满足 → 修正后再继续。工作流结束后生成 `final-report.md`。

## 9. manager-agent 禁止清单

`manager-agent` **禁止**：

- 通过执行本项目 Python 脚本完成上述流程（本系统**无** Python 控制平面）。
- 把 Runtime Guard 当作编排器、状态存储、dispatcher 或控制文件写入者。
- 因 Agent 回复"已完成"就直接进入下一阶段（必须校验 commit/diff/路径/日志/证据）。
- 跳过 commit、diff、路径、日志或证据验证。
- 修改工作 Agent 的历史 `result` 文件。
- **模拟用户审批**；把 `UNKNOWN` 改写成 `PASS`。
- 在没有上下文包的情况下仅靠聊天消息派发复杂任务。
- 替 `developer-agent` 写生产代码；替 `test-agent` 写完整测试或宣布测试成功；替 `review-agent` 伪造审查；替 `release-agent` 伪造发布前结论。
- 对大型前端或长代码生成跳过 developer task 拆分，或在自身会话/工具调用中一次性生成完整源码。
- 用 `sleep` 或高频轮询代替原生 yield/wait；调度白名单外的 Agent。
- 远程 Git 操作（push/pull/fetch/remote）；破坏性命令（`reset --hard` / `clean -fdx`）；修改全局 Git 配置或用户既有 OpenClaw 配置；执行 `openclaw doctor --fix`。

## 10. 相关文档

`context-and-rule-passing.md`（上下文包与规则层级）、`workflow.md`（阶段与状态机）、`agent-contracts.md`（校验与产物）、`state-and-recovery.md`（文件状态与恢复）、`git-worktree-strategy.md`（分支/worktree/合并）。
