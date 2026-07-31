# Trusted Runtime Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free, fail-closed runtime guard that enforces workflow state, JSON contracts, event integrity, Gate aggregation, and approval scope.

**Architecture:** Keep manager-agent as the orchestrator and add one stateless Node.js guard invoked at control boundaries. Machine-readable state transitions and two missing control schemas make cross-file checks deterministic without reintroducing a background control plane.

**Tech Stack:** Node.js 22 standard library, JSON Schema Draft-07 subset, Bash, PowerShell 7, Node `node:test`.

## Global Constraints

- No Python runtime control plane, daemon, dispatcher, network access, or npm dependency.
- Guard failures are fail-closed and never rewrite historical Agent artifacts.
- README records results only; CHANGELOG records change, reason, and effect.
- Current historical Windows runtime is unavailable and must not be auto-migrated.

---

### Task 1: Runtime Guard Behavioral Tests

**Files:**
- Create: `tests/runtime-guard.test.mjs`
- Create later: `scripts/runtime-guard.mjs`

**Interfaces:**
- Consumes: CLI commands `validate-file`, `append-event`, and `check-workflow`.
- Produces: observable exit codes, JSON stdout, and appended event lines.

- [ ] **Step 1: Write tests against the desired CLI**

Use `node:test`, `assert/strict`, `spawnSync`, and `mkdtempSync`. Each test creates a real temporary runtime and invokes `node scripts/runtime-guard.mjs ...`.

Required test names:
=======
=======
>>>>>>> theirs
# 可信 Runtime Guard 实施计划

> **面向 Agent 执行者：** 必须使用子技能：推荐 `superpowers:subagent-driven-development`，或使用 `superpowers:executing-plans` 按任务执行本计划。步骤使用复选框（`- [ ]`）记录状态。

**目标：** 增加无额外依赖、失败关闭的运行时 Guard，强制校验工作流状态、JSON 契约、事件完整性、Gate 聚合和审批作用域。

**架构：** 保持 manager-agent 为编排者，在控制边界加入一个无状态 Node.js Guard。机器可读的状态迁移和两份缺失控制 Schema 使跨文件校验确定化，同时不重新引入后台控制平面。

**技术栈：** Node.js 22 标准库、JSON Schema Draft-07 子集、Bash、PowerShell 7、Node `node:test`。

## 全局约束

- 不得引入 Python 运行时控制平面、daemon、调度器、网络访问或 npm 依赖。
- Guard 失败必须失败关闭，且绝不改写历史 Agent 产物。
- README 只记录结果；CHANGELOG 记录变更、原因和效果。
- 当前历史 Windows Runtime 不可用，不得自动迁移。

---

### 任务 1：Runtime Guard 行为测试

**文件：**

- 新建：`tests/runtime-guard.test.mjs`
- 后续新建：`scripts/runtime-guard.mjs`

**接口：**

- 消费 CLI 命令 `validate-file`、`append-event` 和 `check-workflow`。
- 产出可观察的退出码、JSON stdout 和追加的事件行。

- [ ] **步骤 1：针对目标 CLI 编写测试**

使用 `node:test`、`assert/strict`、`spawnSync` 和 `mkdtempSync`。每个测试创建真实临时 Runtime 并调用 `node scripts/runtime-guard.mjs ...`。

必需测试名称：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```text
validate-file rejects malformed JSON
validate-file rejects a result missing agent_id
append-event creates a deterministic first hash
check-workflow rejects an invalid workflow transition
check-workflow rejects active index revision drift
check-workflow rejects a null or tampered event hash
check-workflow rejects FAIL items with PASS overall
check-workflow rejects PASS while an approval is pending
check-workflow rejects approval responses reused across task or run
check-workflow rejects release PASS with open HIGH findings
check-workflow accepts a consistent minimal workflow
```

<<<<<<< ours
<<<<<<< ours
- [ ] **Step 2: Run tests and verify RED**

Run:
=======
- [ ] **步骤 2：运行测试并验证 RED**

运行：
>>>>>>> theirs
=======
- [ ] **步骤 2：运行测试并验证 RED**

运行：
>>>>>>> theirs

```bash
node --test tests/runtime-guard.test.mjs
```

<<<<<<< ours
<<<<<<< ours
Expected: FAIL because `scripts/runtime-guard.mjs` does not exist.

- [ ] **Step 3: Commit the failing tests**
=======
预期：因 `scripts/runtime-guard.mjs` 不存在而失败。

- [ ] **步骤 3：提交失败测试**
>>>>>>> theirs
=======
预期：因 `scripts/runtime-guard.mjs` 不存在而失败。

- [ ] **步骤 3：提交失败测试**
>>>>>>> theirs

```bash
git add tests/runtime-guard.test.mjs
git commit -m "test: define runtime guard behavior"
```

<<<<<<< ours
<<<<<<< ours
### Task 2: Schema Subset Validator and CLI

**Files:**
- Create: `scripts/runtime-guard.mjs`

**Interfaces:**
- Consumes: `--schema`, `--file`, `--jsonl`, `--allow-placeholders`.
- Produces: `{ "ok": true, ... }` on stdout and exit 0; `{ "ok": false, "errors": [...] }` and exit 1 on failure.

- [ ] **Step 1: Implement argument parsing and deterministic JSON output**
- [ ] **Step 2: Implement JSON/JSONL parsing with line-numbered errors**
- [ ] **Step 3: Implement the supported Draft-07 keyword subset and local `$ref`**
- [ ] **Step 4: Reject unsupported assertion keywords and runtime placeholders**
- [ ] **Step 5: Run the focused validate-file tests**

Run:
=======
=======
>>>>>>> theirs
### 任务 2：Schema 子集校验器与 CLI

**文件：**

- 新建：`scripts/runtime-guard.mjs`

**接口：**

- 消费：`--schema`、`--file`、`--jsonl`、`--allow-placeholders`。
- 通过时 stdout 输出 `{ "ok": true, ... }` 且退出码为 0；失败时输出 `{ "ok": false, "errors": [...] }` 且退出码为 1。

- [ ] **步骤 1：实现参数解析与确定性 JSON 输出**
- [ ] **步骤 2：实现 JSON/JSONL 解析与带行号的错误**
- [ ] **步骤 3：实现受支持的 Draft-07 关键字子集与本地 `$ref`**
- [ ] **步骤 4：拒绝未支持的断言关键字与运行时占位符**
- [ ] **步骤 5：运行聚焦的 validate-file 测试**

运行：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
node --test --test-name-pattern='validate-file' tests/runtime-guard.test.mjs
```

<<<<<<< ours
<<<<<<< ours
Expected: PASS.

### Task 3: State and Event Contracts

**Files:**
- Create: `config/workflow-state-machine.json`
- Create: `contracts/active-workflows.schema.json`
- Create: `contracts/workflow-event.schema.json`
- Modify: `contracts/workflow.schema.json`
- Create: `templates/active-workflows.json`
- Create: `templates/workflow-event.json`
- Modify: `templates/workflow.json`
- Modify: `templates/task.json`
- Modify: `templates/result.json`

**Interfaces:**
- Consumes: workflow/task current and previous states.
- Produces: `state_revision`, legal transition tables, canonical event schema, safe template defaults.

- [ ] **Step 1: Add workflow and task transition maps**
- [ ] **Step 2: Add HOLD, WAITING_HUMAN, state_revision, and phase enum to workflow schema**
- [ ] **Step 3: Define strict active index and workflow event schemas**
- [ ] **Step 4: Add safe templates with empty approvals and non-success result defaults**
- [ ] **Step 5: Run schema JSON parsing checks**

Run:
=======
=======
>>>>>>> theirs
预期：通过。

### 任务 3：状态与事件契约

**文件：**

- 新建：`config/workflow-state-machine.json`
- 新建：`contracts/active-workflows.schema.json`
- 新建：`contracts/workflow-event.schema.json`
- 修改：`contracts/workflow.schema.json`
- 新建：`templates/active-workflows.json`
- 新建：`templates/workflow-event.json`
- 修改：`templates/workflow.json`
- 修改：`templates/task.json`
- 修改：`templates/result.json`

**接口：**

- 消费：workflow/task 的当前与前一状态。
- 产出：`state_revision`、合法迁移表、规范化事件 Schema 和安全的模板默认值。

- [ ] **步骤 1：添加 workflow 与 task 迁移映射**
- [ ] **步骤 2：向 workflow Schema 添加 HOLD、WAITING_HUMAN、state_revision 和 phase 枚举**
- [ ] **步骤 3：定义严格的活动索引与 workflow 事件 Schema**
- [ ] **步骤 4：添加审批为空及非成功结果默认值的安全模板**
- [ ] **步骤 5：运行 Schema JSON 解析检查**

运行：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
for file in contracts/*.json config/workflow-state-machine.json templates/*.json; do jq empty "$file"; done
```

<<<<<<< ours
<<<<<<< ours
Expected: exit 0.

### Task 4: Event Append and Workflow Consistency

**Files:**
- Modify: `scripts/runtime-guard.mjs`

**Interfaces:**
- `append-event --events <path> --event <draft-path> --project-root <path>`
- `check-workflow --project-root <path> --runtime-root <path> --workflow-id <id> [--skip-git]`

- [ ] **Step 1: Implement recursive canonical JSON and SHA-256**
- [ ] **Step 2: Implement append-only event creation with fsync**
- [ ] **Step 3: Validate event seq, previous hash, recomputed hash, workflow transition, task transition, and latest snapshot match**
- [ ] **Step 4: Validate active index, task references, pending decisions, result IDs, JSONL evidence, and Git candidate**
- [ ] **Step 5: Run event and state tests**

Run:
=======
=======
>>>>>>> theirs
预期：退出码为 0。

### 任务 4：事件追加与工作流一致性

**文件：**

- 修改：`scripts/runtime-guard.mjs`

**接口：**

- `append-event --events <path> --event <draft-path> --project-root <path>`
- `check-workflow --project-root <path> --runtime-root <path> --workflow-id <id> [--skip-git]`

- [ ] **步骤 1：实现递归规范 JSON 与 SHA-256**
- [ ] **步骤 2：实现带 fsync 的 append-only 事件创建**
- [ ] **步骤 3：校验事件 seq、前序哈希、重新计算的哈希、workflow 迁移、task 迁移及最新快照匹配**
- [ ] **步骤 4：校验活动索引、task 引用、待决 decisions、result ID、JSONL evidence 和 Git candidate**
- [ ] **步骤 5：运行事件与状态测试**

运行：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
node --test --test-name-pattern='append-event|transition|revision|event hash|consistent minimal workflow' tests/runtime-guard.test.mjs
```

<<<<<<< ours
<<<<<<< ours
Expected: PASS.

### Task 5: Gate and Approval Enforcement

**Files:**
- Modify: `contracts/gate-result.schema.json`
- Modify: `contracts/approval-request.schema.json`
- Modify: `contracts/approval-response.schema.json`
- Create: `templates/gate-result.json`
- Create: `templates/approval-request.json`
- Create: `templates/approval-response.json`
- Modify: `scripts/runtime-guard.mjs`

**Interfaces:**
- Gate items require `blocking`; Gate requires `overall_reason` and `approved_decision_ids`.
- Approval request/response bind `decision_id`, `workflow_id`, `task_id`, and `run_id`.

- [ ] **Step 1: Tighten Gate and approval schemas**
- [ ] **Step 2: Recompute expected Gate overall from item statuses**
- [ ] **Step 3: Block PASS for pending approvals and open BLOCKER/CRITICAL/HIGH findings**
- [ ] **Step 4: Validate approval option and scope matching**
- [ ] **Step 5: Validate ReleaseReadinessGate against release verdict**
- [ ] **Step 6: Run Gate and approval tests**

Run:
=======
=======
>>>>>>> theirs
预期：通过。

### 任务 5：Gate 与审批强制执行

**文件：**

- 修改：`contracts/gate-result.schema.json`
- 修改：`contracts/approval-request.schema.json`
- 修改：`contracts/approval-response.schema.json`
- 新建：`templates/gate-result.json`
- 新建：`templates/approval-request.json`
- 新建：`templates/approval-response.json`
- 修改：`scripts/runtime-guard.mjs`

**接口：**

- Gate item 必须包含 `blocking`；Gate 必须包含 `overall_reason` 和 `approved_decision_ids`。
- 审批 request/response 绑定 `decision_id`、`workflow_id`、`task_id` 和 `run_id`。

- [ ] **步骤 1：收紧 Gate 与审批 Schema**
- [ ] **步骤 2：由 item 状态重新计算预期 Gate overall**
- [ ] **步骤 3：当存在待决审批或未关闭 BLOCKER/CRITICAL/HIGH finding 时阻断 PASS**
- [ ] **步骤 4：校验审批 option 与作用域匹配**
- [ ] **步骤 5：针对 release verdict 校验 ReleaseReadinessGate**
- [ ] **步骤 6：运行 Gate 与审批测试**

运行：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
node --test --test-name-pattern='FAIL items|approval|HIGH findings|release' tests/runtime-guard.test.mjs
```

<<<<<<< ours
<<<<<<< ours
Expected: PASS.

### Task 6: Manager and Installer Integration

**Files:**
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `agents/common/APPROVAL_RULES.md`
- Modify: `scripts/validate-install.sh`
- Modify: `scripts/validate-install.ps1`

**Interfaces:**
- Manager invokes Guard before and after control boundaries.
- Static validators invoke Node tests and validate schemas/templates through Guard.

- [ ] **Step 1: Permit only the stateless Runtime Guard exception to the no-control-plane rule**
- [ ] **Step 2: Require Guard success before spawn, merge, phase advance, recovery, and completion claims**
- [ ] **Step 3: Replace invalid HOLD result language with task/workflow HOLD behavior**
- [ ] **Step 4: Call Guard self-check and Node tests from Bash and PowerShell validators**
- [ ] **Step 5: Run Bash installation validation**

Run:
=======
=======
>>>>>>> theirs
预期：通过。

### 任务 6：Manager 与安装器集成

**文件：**

- 修改：`agents/manager-agent/workspace/AGENTS.md`
- 修改：`agents/manager-agent/workspace/TOOLS.md`
- 修改：`agents/common/APPROVAL_RULES.md`
- 修改：`scripts/validate-install.sh`
- 修改：`scripts/validate-install.ps1`

**接口：**

- Manager 在控制边界前后调用 Guard。
- 静态校验器调用 Node 测试，并经由 Guard 校验 Schema/模板。

- [ ] **步骤 1：在禁止控制平面规则中仅允许无状态 Runtime Guard 作为例外**
- [ ] **步骤 2：要求在 spawn、merge、阶段推进、恢复和完成声明前 Guard 成功**
- [ ] **步骤 3：将不合法的 HOLD result 描述替换为 task/workflow HOLD 行为**
- [ ] **步骤 4：从 Bash 和 PowerShell 校验器调用 Guard self-check 与 Node 测试**
- [ ] **步骤 5：运行 Bash 安装校验**

运行：
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
bash scripts/validate-install.sh --skip-openclaw
```

<<<<<<< ours
<<<<<<< ours
Expected: all checks PASS.

### Task 7: Documentation and Release Notes

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/workflow.md`
- Modify: `docs/manager-orchestration.md`
- Modify: `docs/state-and-recovery.md`
- Modify: `docs/agent-contracts.md`
- Modify: `docs/gate-checklists.md`
- Modify: `docs/human-approval.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documentation matches executable states and commands.
- README contains results only.
- CHANGELOG contains what, why, and effect.

- [ ] **Step 1: Document the stateless Guard architecture boundary**
- [ ] **Step 2: Replace contradictory HOLD and WAITING_HUMAN language**
- [ ] **Step 3: Document canonical event hashing, Gate aggregation, and approval binding**
- [ ] **Step 4: Add concise README usage and achieved guarantees**
- [ ] **Step 5: Add CHANGELOG entry with change/reason/effect**

### Task 8: Full Verification and Review

**Files:**
- Review all modified files.

- [ ] **Step 1: Run the complete Node test suite**
=======
=======
>>>>>>> theirs
预期：全部检查通过。

### 任务 7：文档与发行说明

**文件：**

- 修改：`docs/architecture.md`
- 修改：`docs/workflow.md`
- 修改：`docs/manager-orchestration.md`
- 修改：`docs/state-and-recovery.md`
- 修改：`docs/agent-contracts.md`
- 修改：`docs/gate-checklists.md`
- 修改：`docs/human-approval.md`
- 修改：`README.md`
- 修改：`CHANGELOG.md`

**接口：**

- 文档与可执行状态和命令保持一致。
- README 只包含结果。
- CHANGELOG 包含变更内容、原因和效果。

- [ ] **步骤 1：记录无状态 Guard 的架构边界**
- [ ] **步骤 2：替换相互矛盾的 HOLD 与 WAITING_HUMAN 描述**
- [ ] **步骤 3：记录规范事件哈希、Gate 聚合与审批绑定**
- [ ] **步骤 4：增加精炼的 README 使用说明与已达成保证**
- [ ] **步骤 5：增加包含变更/原因/效果的 CHANGELOG 条目**

### 任务 8：完整验证与审查

**文件：**

- 审查全部修改文件。

- [ ] **步骤 1：运行完整 Node 测试套件**
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs

```bash
node --test tests/runtime-guard.test.mjs
```

<<<<<<< ours
<<<<<<< ours
- [ ] **Step 2: Run Bash static validation**
=======
- [ ] **步骤 2：运行 Bash 静态校验**
>>>>>>> theirs
=======
- [ ] **步骤 2：运行 Bash 静态校验**
>>>>>>> theirs

```bash
bash scripts/validate-install.sh --skip-openclaw
```

<<<<<<< ours
<<<<<<< ours
- [ ] **Step 3: Run syntax and JSON checks**
=======
- [ ] **步骤 3：运行语法与 JSON 检查**
>>>>>>> theirs
=======
- [ ] **步骤 3：运行语法与 JSON 检查**
>>>>>>> theirs

```bash
bash -n scripts/*.sh
node --check scripts/runtime-guard.mjs
for file in contracts/*.json config/*.json templates/*.json; do jq empty "$file"; done
```

<<<<<<< ours
<<<<<<< ours
- [ ] **Step 4: Confirm repository diff is scoped and contains no runtime artifacts**
=======
- [ ] **步骤 4：确认仓库 diff 范围正确且没有 runtime 产物**
>>>>>>> theirs
=======
- [ ] **步骤 4：确认仓库 diff 范围正确且没有 runtime 产物**
>>>>>>> theirs

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

<<<<<<< ours
<<<<<<< ours
- [ ] **Step 5: Request independent code review and address Critical/Important findings**
- [ ] **Step 6: Commit the verified implementation**
=======
- [ ] **步骤 5：请求独立代码审查并处理 Critical/Important 发现**
- [ ] **步骤 6：提交已验证的实现**
>>>>>>> theirs
=======
- [ ] **步骤 5：请求独立代码审查并处理 Critical/Important 发现**
- [ ] **步骤 6：提交已验证的实现**
>>>>>>> theirs

```bash
git add scripts/runtime-guard.mjs tests/runtime-guard.test.mjs config contracts templates agents docs README.md CHANGELOG.md
git commit -m "feat: enforce trusted workflow runtime state"
```
