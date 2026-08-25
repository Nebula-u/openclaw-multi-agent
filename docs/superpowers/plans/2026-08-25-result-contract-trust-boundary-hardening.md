# Result Contract Trust-Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `result.json` 收敛为 Host 可核验的执行收据和证据索引，并由 runner 注入权威的 `started_at`、`finished_at`，禁止 Agent 控制这两个时间字段。

**Architecture:** Agent 只写不含 Host 所有字段的 raw result payload；Orchestrator 在 runner 调用前后记录时间，解析 raw payload 后注入时间，再执行严格 schema、身份、引用和跨字段校验，最后发布规范化结果。外部证据继续使用独立 JSON/JSONL 契约，`result.json` 只保存受控引用；主观字段限制长度、数量、枚举和证据关联。

**Tech Stack:** Node.js 22、Ajv Draft-07、Node `node:test`、Orchestrator SQLite Kernel、PowerShell/Bash 安装与校验脚本。

## Global Constraints

- 本文档只记录实施计划；创建本文档时不得修改 schema、runner、Orchestrator、Agent、模板或 runtime。
- `started_at`、`finished_at` 由 Orchestrator 在 runner 调用边界记录并注入；Agent raw payload 出现任一字段都必须失败关闭。
- 最终发布的 `result.json` 仍必须包含 `started_at`、`finished_at`，且通过 `format: date-time`。
- A 类字段由 Host 逐字段核验；B 类字段只存引用；C 类字段不得改变 Kernel、Gate、Acceptance Criteria 或审批事实。
- `result.schema.json` 改为 `additionalProperties: false`，未声明的扩展字段一律拒绝。
- `implementation`、`gate_checks`、`validation`、`acceptance_criteria_status`、`branch`、`target_project_root_abs` 从结果契约删除。
- `sandbox_attestation` 只允许在 `isolation_mode = SANDBOXED_DOCKER` 时出现。
- 空的可选数组必须省略，不能输出 `[]`。
- `summary_for_user`、`summary_for_manager` 各不超过 200 字符；Manager 摘要必须引用至少一个本结果中的 evidence ID。
- `claims` 最多 5 条，只允许 `OBSERVED`，每条至少引用一个 evidence ID。
- `unresolved_issues` 与 `known_limitations` 语义分离，同一字符串不得同时出现。
- `architecture_deviation_note` 为唯一允许新增的可选偏离说明，类型为 string，最大 500 字符。
- `decisions_required` 只引用通过 `approval-request.schema.json` 校验的独立产物，不再内联自由 object。
- 实施会影响 `agents/*/workspace/`、`agents/common/`、模板和已安装 runtime；交付时必须提醒更新已安装 Agent，但普通更新不要求停止 Gateway。

---

## 设计决策记录

采用方案：Orchestrator 在 raw JSON 解析后、最终 schema 校验前注入 runner 时间。

- 优点：最终 `result.schema.json` 仍是一份完整发布契约；Agent 无法覆盖时间；raw SHA-256 和 Host 注入变换均可进入 receipt。
- 拒绝“只信 Agent 时间”：它仍是证人自陈，无法构成 Host 信任锚点。
- 拒绝“把时间移出 result.json”：会拆散一次执行的权威收据，并使下游必须联查 execution 才能读取基本生命周期。
- 拒绝“runner 预写半成品 JSON、Agent 原地补字段”：会引入并发覆盖、部分写入和所有权不清问题。

权威时间定义：

- `started_at`：Orchestrator 即将调用 worker runner 前的 `now(clock)`。
- `finished_at`：worker runner Promise 成功返回后的首个 `now(clock)`，发生在结果解析、校验、快照和发布之前。
- runner 抛错、超时或 lease 丢失时不发布 result；执行终止时间继续由 Kernel `executions.finished_at` 记录。

---

### Task 1: 锁定最终 Result Schema

**Files:**

- Modify: `contracts/result.schema.json`
- Create: `tests/orchestrator-result-contract.test.mjs`
- Modify: `tests/agent-llm-json-harness.test.mjs`

**Interfaces:**

- `result.schema.json` 描述 Host 注入完成后的发布结果，而不是 Agent raw payload。
- 必填 A 类字段保持：identity、role、attempt、runner timestamps、status、paths、commits、isolation、manifest hash。
- 可选数组一旦出现，必须 `minItems: 1` 且 `uniqueItems: true`。

- [ ] **Step 1: 写严格 schema 的失败测试**

  在 `tests/orchestrator-result-contract.test.mjs` 用 Ajv 加载真实 schema，构造一个最小合法发布结果，并新增以下断言：

  ```js
  assert.equal(validate(validPublishedResult), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...validPublishedResult, implementation: {} }), false);
  assert.equal(validate({ ...validPublishedResult, branch: null }), false);
  assert.equal(validate({ ...validPublishedResult, created_files: [] }), false);
  assert.equal(validate({ ...validPublishedResult, isolation_mode: 'UNSANDBOXED_LOCAL', sandbox_attestation: null }), false);
  assert.equal(validate({ ...validPublishedResult, summary_for_user: 'x'.repeat(201) }), false);
  ```

- [ ] **Step 2: 运行测试并确认当前契约失败**

  Run: `node --test tests/orchestrator-result-contract.test.mjs`

  Expected: FAIL，因为当前 schema 允许额外字段、空数组、过长摘要和本地模式的 `sandbox_attestation`。

- [ ] **Step 3: 收紧顶层字段**

  修改 `contracts/result.schema.json`：

  ```json
  {
    "additionalProperties": false,
    "properties": {
      "summary_for_user": { "type": "string", "minLength": 1, "maxLength": 200 },
      "summary_for_manager": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "EVD-" },
      "architecture_deviation_note": { "type": "string", "minLength": 1, "maxLength": 500 }
    }
  }
  ```

  删除 `branch`；不要增加 `target_project_root_abs`、`implementation`、`gate_checks`、`validation`、`acceptance_criteria_status`。保留 `started_at`、`finished_at` 为最终发布结果必填字段。

- [ ] **Step 4: 收紧数组与条件字段**

  对 `created_files`、`modified_files`、`deleted_files`、`report_files`、`command_record_refs`、`evidence_refs`、`unresolved_issues`、`known_limitations`、`findings`、`decisions_required` 设置 `minItems: 1`、`uniqueItems: true`。`findings` 和 `decisions_required` 的 item 改为非空 string artifact path，不再接受 object。

  为 `sandbox_attestation` 增加互斥条件：Docker 模式必须出现 object，本地模式不得出现该键。

- [ ] **Step 5: 锁定 self-validation 和 claims**

  `self_validation.additionalProperties` 设为 `false`；`checks` 使用 Draft-07 tuple validation，固定且仅允许以下顺序：

  ```text
  expected_outputs_present
  no_forbidden_path_writes
  static_analysis_executed
  ```

  设置 `minItems = maxItems = 3`、`additionalItems: false`。每项只允许 `name`、`status`、`detail`。

  `claims` 设置 `maxItems: 5`；每条 `classification` 使用 `const: OBSERVED`，`evidence_refs` 至少一项并匹配 `^EVD-`，claim object 使用 `additionalProperties: false`。

- [ ] **Step 6: 更新独立契约测试样本**

  修改 `tests/agent-llm-json-harness.test.mjs` 中的 result 成功样本，使其包含固定三项 self-validation，且不包含被删除字段。该测试针对最终发布 schema，因此仍保留 runner timestamps。

- [ ] **Step 7: 运行聚焦测试**

  Run: `node --test tests/orchestrator-result-contract.test.mjs tests/agent-llm-json-harness.test.mjs`

  Expected: PASS。

- [ ] **Step 8: 提交 Task 1**

  ```bash
  git add contracts/result.schema.json tests/orchestrator-result-contract.test.mjs tests/agent-llm-json-harness.test.mjs
  git commit -m "refactor(contract): harden agent result schema"
  ```

---

### Task 2: 由 Runner 注入权威时间

**Files:**

- Modify: `scripts/orchestrator/service.mjs`
- Modify: `scripts/orchestrator/output-ingestion.mjs`
- Create: `tests/orchestrator-output-ingestion.test.mjs`
- Modify: `tests/orchestrator-result-status.test.mjs`

**Interfaces:**

- `ingestTaskOutput({ projectRoot, task, runnerTiming, occurredAt })`
- `runnerTiming` 精确为 `{ startedAt: string, finishedAt: string }`。
- Agent raw payload 不得包含 `started_at` 或 `finished_at`。
- 发布值由 `runnerTiming` 注入并写入 `output/result.json`。

- [ ] **Step 1: 写禁止 Agent 时间字段的失败测试**

  新测试覆盖：raw payload 缺少两个时间时可由 Host 注入并成功；raw payload 携带任一时间时抛出固定错误。

  ```js
  assert.equal(published.started_at, '2026-08-25T08:00:00.000Z');
  assert.equal(published.finished_at, '2026-08-25T08:00:07.000Z');
  assert.throws(
    () => ingestTaskOutput({ ...fixture, runnerTiming, rawOverrides: { started_at: '2000-01-01T00:00:00Z' } }),
    (error) => error.code === 'AGENT_OUTPUT_HOST_FIELD_FORBIDDEN',
  );
  ```

- [ ] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/orchestrator-output-ingestion.test.mjs`

  Expected: FAIL，因为当前 ingestion 要求 Agent 自己提供时间。

- [ ] **Step 3: 在 runner 边界捕获时间**

  在 `scripts/orchestrator/service.mjs` 调用 `runWithLeaseHeartbeat` 的位置采用以下顺序：

  ```js
  const runnerStartedAt = now(clock);
  const result = await runWithLeaseHeartbeat({
    lease: selectedKernel.lease,
    executionId: execution.executionId,
    signal,
    run: (heartbeatSignal) => runner({ agentId: task.agentId, sessionId, messagePath, timeoutSeconds, signal: heartbeatSignal }),
  });
  const runnerFinishedAt = now(clock);
  const ingested = ingestTaskOutput({
    projectRoot,
    task,
    runnerTiming: { startedAt: runnerStartedAt, finishedAt: runnerFinishedAt },
    occurredAt: now(clock),
  });
  ```

- [ ] **Step 4: 在 ingestion 中拒绝并注入 Host 字段**

  解析 raw JSON 后先检查原始对象：

  ```js
  for (const field of ['started_at', 'finished_at']) {
    if (Object.hasOwn(ingestion.value, field)) {
      throw new OutputBoundaryError('AGENT_OUTPUT_HOST_FIELD_FORBIDDEN', `${field} is owned by the runner`, { field });
    }
  }
  const value = {
    ...ingestion.value,
    started_at: runnerTiming.startedAt,
    finished_at: runnerTiming.finishedAt,
  };
  ```

  校验 `runnerTiming` 两个值存在、为有效 ISO date-time 且 `finishedAt >= startedAt`。最终发布规范化 `value`，不能继续写原始 `ingestion.text`。

- [ ] **Step 5: 在 ingestion receipt 记录 Host 变换**

  receipt 增加：

  ```json
  {
    "host_injections": ["started_at", "finished_at"],
    "runner_started_at": "2026-08-25T08:00:00.000Z",
    "runner_finished_at": "2026-08-25T08:00:07.000Z"
  }
  ```

  保留原始 raw SHA-256 与最终 published SHA-256，使两者可独立审计。

- [ ] **Step 6: 更新 Orchestrator 结果状态测试**

  `tests/orchestrator-result-status.test.mjs` 中 Agent fixture 删除两个时间字段，使用可控 `clock` 断言最终 result 获得 Host 时间；再增加 Agent 伪造时间被拒绝的用例。

- [ ] **Step 7: 运行聚焦测试**

  Run: `node --test tests/orchestrator-output-ingestion.test.mjs tests/orchestrator-result-status.test.mjs tests/orchestrator-lease-heartbeat.test.mjs`

  Expected: PASS，且 lease 失败路径不发布 result。

- [ ] **Step 8: 提交 Task 2**

  ```bash
  git add scripts/orchestrator/service.mjs scripts/orchestrator/output-ingestion.mjs tests/orchestrator-output-ingestion.test.mjs tests/orchestrator-result-status.test.mjs
  git commit -m "feat(orchestrator): inject authoritative runner timestamps"
  ```

---

### Task 3: 校验并发布 B 类引用产物

**Files:**

- Create: `scripts/orchestrator/referenced-artifacts.mjs`
- Modify: `scripts/orchestrator/output-ingestion.mjs`
- Modify: `scripts/orchestrator/service.mjs`
- Create: `tests/orchestrator-referenced-artifacts.test.mjs`
- Modify: `contracts/evidence.schema.json`
- Modify: `contracts/command-record.schema.json`
- Modify: `templates/evidence.jsonl`
- Modify: `templates/command-records.jsonl`

**Interfaces:**

- `ingestReferencedArtifacts({ projectRoot, task, result })` 返回 `{ published, registrations }`。
- `published` 含规范化后 evidence、command records、reports、findings 和 approval requests。
- `registrations` 每项含 `kind`、`path_abs`、`sha256`、`size_bytes`、`media_type`。

- [ ] **Step 1: 写引用边界的失败测试**

  覆盖以下情况：引用不存在、路径逃逸、符号链接、错误 task/run/attempt、错误 schema、文件在 result 写完后被修改、空数组、重复引用。每种情况断言固定错误码，不允许静默跳过。

- [ ] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/orchestrator-referenced-artifacts.test.mjs`

  Expected: FAIL，因为当前代码只检查少量绝对路径，且不会发布 JSONL 或登记其 hash。

- [ ] **Step 3: 规范化 Evidence 和 CommandRecord 契约**

  将 `evidence.schema.json`、`command-record.schema.json` 的 `additionalProperties` 改为 `false`。Evidence ID 统一 `^EVD-`；command/evidence 的 SHA-256 只接受小写 64 位值或 `null`。命令即使没有输出也必须保存空 stdout/stderr 文件及空文件 SHA-256，路径不得为空字符串。

  同步修改 `templates/evidence.jsonl`、`templates/command-records.jsonl`，确保 ID、非空日志路径、小写 hash 和必填字段与收紧后的契约完全一致。

- [ ] **Step 4: 实现引用解析与发布**

  引用规则固定为：

  - `created_files`、`modified_files`、`deleted_files` 相对 `worktree_path_abs` 解析，并与 Host Git diff 对照。
  - `report_files`、`findings`、`decisions_required` 必须解析到 `artifact_root_abs/.agent-raw/` 内的普通文件。
  - `command_record_refs` 必须解析到当前 `command-records.jsonl.raw` 中的 ID。
  - `evidence_refs` 必须解析到当前 `evidence.jsonl.raw` 中的 ID。
  - Evidence 引用 CommandRecord 时，目标必须存在于同一 task/run/attempt。

  所有结构化产物校验通过后原子发布到 `output/`，然后计算 SHA-256；不允许先登记 hash 后继续写文件。

- [ ] **Step 5: 在 Kernel 登记每个发布产物**

  修改 `service.mjs`，遍历 `registrations` 调用 `registerArtifact`。使用真实文件大小，不再统一写 `sizeBytes: 0`。

- [ ] **Step 6: 运行聚焦测试**

  Run: `node --test tests/orchestrator-referenced-artifacts.test.mjs tests/orchestrator-output-ingestion.test.mjs`

  Expected: PASS。

- [ ] **Step 7: 提交 Task 3**

  ```bash
  git add scripts/orchestrator/referenced-artifacts.mjs scripts/orchestrator/output-ingestion.mjs scripts/orchestrator/service.mjs contracts/evidence.schema.json contracts/command-record.schema.json templates/evidence.jsonl templates/command-records.jsonl tests/orchestrator-referenced-artifacts.test.mjs
  git commit -m "feat(orchestrator): verify referenced result artifacts"
  ```

---

### Task 4: 强制 C 类字段的语义边界

**Files:**

- Modify: `scripts/orchestrator/output-ingestion.mjs`
- Modify: `scripts/orchestrator/service.mjs`
- Modify: `agents/common/APPROVAL_RULES.md`
- Modify: `agents/common/EVIDENCE_RULES.md`
- Modify: `tests/orchestrator-result-contract.test.mjs`
- Modify: `tests/orchestrator-result-status.test.mjs`

**Interfaces:**

- `validateResultSemantics(task, value, referencedArtifacts)` 只返回成功或抛出固定 `OutputBoundaryError`。
- `decisions_required[]` 每项是当前 task artifact 内通过审批 schema 的文件路径。
- `findings[]` 每项是通过 `review-findings.schema.json` 的文件路径。

- [ ] **Step 1: 写跨字段语义失败测试**

  覆盖：Manager 摘要未引用 evidence、引用不存在、claims 非 `OBSERVED`、claim 无 evidence、两类问题数组重复、Docker 缺 attestation、本地携带 attestation、审批引用不是当前 task/run。

- [ ] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/orchestrator-result-contract.test.mjs tests/orchestrator-result-status.test.mjs`

  Expected: FAIL。

- [ ] **Step 3: 实现语义校验**

  `role` 必须等于当前 task kind；`summary_for_manager` 中至少出现一个同时存在于顶层 `evidence_refs` 的 ID。每条 claim 的引用必须是顶层 evidence 子集。使用完全相等的规范化字符串检查 `unresolved_issues` 与 `known_limitations` 交集为空。

  `result_status` 仍是 Agent 申报值，但不得直接成为 Kernel 权威状态：只有 schema、identity、runner timing、commit/path、引用产物和跨字段语义全部通过后，Orchestrator 才能按该枚举执行后续状态转换。`isolation_mode` 和 Docker attestation 必须与 runner/执行上下文一致，不能只检查 Agent 字符串是否合法。

- [ ] **Step 4: 将审批改为独立产物引用**

  `approvalRequest(task, result)` 不再读取内联 object。对于 `HUMAN_DECISION_REQUIRED`，加载 `decisions_required[0]` 指向的已校验 `approval-request.json`；禁止 fallback 生成任意 options。自动 route approval 继续由 Host 基于 route step 生成，不经过 Agent result。

- [ ] **Step 5: 更新共同规则**

  `APPROVAL_RULES.md` 明确 Agent 写独立 approval request raw artifact，result 仅引用路径。`EVIDENCE_RULES.md` 明确 claims 只接受最多 5 条 `OBSERVED`，其他分类转入 `unresolved_issues`。

- [ ] **Step 6: 运行聚焦测试**

  Run: `node --test tests/orchestrator-result-contract.test.mjs tests/orchestrator-result-status.test.mjs tests/orchestrator-approval-command.test.mjs`

  Expected: PASS。

- [ ] **Step 7: 提交 Task 4**

  ```bash
  git add scripts/orchestrator/output-ingestion.mjs scripts/orchestrator/service.mjs agents/common/APPROVAL_RULES.md agents/common/EVIDENCE_RULES.md tests/orchestrator-result-contract.test.mjs tests/orchestrator-result-status.test.mjs
  git commit -m "refactor(orchestrator): constrain subjective result fields"
  ```

---

### Task 5: 更新模板和所有 Worker 指令

**Files:**

- Modify: `templates/result.json`
- Modify: `agents/manager-agent/workspace/templates/README.md`
- Modify: `agents/common/COMMON_RULES.md`
- Modify: `agents/requirement-agent/workspace/AGENTS.md`
- Modify: `agents/architect-agent/workspace/AGENTS.md`
- Modify: `agents/developer-agent/workspace/AGENTS.md`
- Modify: `agents/test-agent/workspace/AGENTS.md`
- Modify: `agents/review-agent/workspace/AGENTS.md`
- Modify: `agents/release-agent/workspace/AGENTS.md`
- Modify: `scripts/orchestrator/service.mjs`
- Modify: `tests/orchestrator-request-and-route.test.mjs`
- Modify: `tests/runtime-bundle.test.mjs`
- Modify: `tests/validate-install.test.mjs`

**Interfaces:**

- Task message 明确写出 `started_at`、`finished_at` 为 Host-owned forbidden raw fields。
- Agent result 模板不再出现这两个时间字段。
- 固定 self-validation 三项必须完整出现且顺序固定。

- [ ] **Step 1: 写指令和 bundle 的失败测试**

  断言 task message 包含 “omit started_at and finished_at; the runner injects them”；断言模板不包含这两个键；断言已打包 Worker 规则包含相同约束。

- [ ] **Step 2: 运行测试并确认失败**

  Run: `node --test tests/orchestrator-request-and-route.test.mjs tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`

  Expected: FAIL。

- [ ] **Step 3: 收敛 result 模板**

  `templates/result.json` 删除 runner timestamps、branch、空可选数组、sandbox null 和所有自由扩展字段。保留最小 A 类字段、非空 B 类引用示例、两个短摘要、固定 self-validation、manifest hash；明确这是 `.agent-raw/result.json.raw` payload 模板，最终发布时由 Host 增加时间。

- [ ] **Step 4: 更新通用及角色指令**

  通用规则说明 A/B/C 三类、Host 时间所有权、空数组省略、禁止自由字段。六个 Worker `AGENTS.md` 都将 “write exactly one result.schema.json object” 改为 “write one raw result payload accepted by the Host publication contract”，并明确不得写 `started_at`、`finished_at`。

- [ ] **Step 5: 更新派发消息**

  在 `taskMessage(task)` 中加入：

  ```text
  Omit started_at and finished_at from the raw payload. They are Host-owned fields injected from the runner lifecycle; supplying either field fails closed.
  ```

- [ ] **Step 6: 运行聚焦测试**

  Run: `node --test tests/orchestrator-request-and-route.test.mjs tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`

  Expected: PASS。

- [ ] **Step 7: 提交 Task 5**

  ```bash
  git add templates/result.json agents/manager-agent/workspace/templates/README.md agents/common/COMMON_RULES.md agents/requirement-agent/workspace/AGENTS.md agents/architect-agent/workspace/AGENTS.md agents/developer-agent/workspace/AGENTS.md agents/test-agent/workspace/AGENTS.md agents/review-agent/workspace/AGENTS.md agents/release-agent/workspace/AGENTS.md scripts/orchestrator/service.mjs tests/orchestrator-request-and-route.test.mjs tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
  git commit -m "docs(agent): define host-owned result fields"
  ```

---

### Task 6: 文档、回归验证和安装同步说明

**Files:**

- Modify: `README.md`
- Create: `docs/result-contract-trust-boundary.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/runtime-guard.test.mjs`

**Interfaces:**

- 文档分别说明 Agent raw payload、Host injection、published result 三个阶段。
- 文档列出 A/B/C 字段所有权及失败错误码。

- [ ] **Step 1: 更新用户和维护文档**

  README 增加 runner 时间注入和已安装 Agent 更新说明。新文档给出最小 raw payload、最终 published result、引用发布流程和错误矩阵。CHANGELOG 记录信任边界变更及不兼容字段删除。

- [ ] **Step 2: 增加 Runtime Guard 回归测试**

  覆盖严格 `additionalProperties: false`、固定 self-validation、摘要长度、claims 分类、空数组、条件 attestation 和 Host 注入后的时间格式。

- [ ] **Step 3: 运行完整 Node 测试**

  Run: `npm test`

  Expected: PASS，无失败或跳过的必需测试。

- [ ] **Step 4: 运行安装 dry-run 与平台校验**

  Run: `pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime`

  Expected: dry-run 成功，不修改已安装 Agent。

  Run: `bash scripts/install.sh --runtime-root runtime`

  Expected: dry-run 成功，不修改已安装 Agent。

  Run: `pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime`

  Expected: PASS。

  Run: `bash scripts/validate-install.sh --runtime-root runtime`

  Expected: PASS。

- [ ] **Step 5: 核验 Agent 更新提示**

  最终交付必须先说明“需要更新已安装 Agent”，并给出：

  ```text
  Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
  Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
  ```

  普通更新不要求停止 Gateway；只有普通更新无法恢复且用户准备完整安全重装时，才要求先停止 Gateway 并使用 `scripts/reinstall-agents.ps1`。

- [ ] **Step 6: 提交 Task 6**

  ```bash
  git add README.md docs/result-contract-trust-boundary.md CHANGELOG.md tests/runtime-guard.test.mjs
  git commit -m "docs: document result trust boundary"
  ```

---

## Final Verification Checklist

- [ ] Agent raw payload 携带 `started_at` 时以 `AGENT_OUTPUT_HOST_FIELD_FORBIDDEN` 失败。
- [ ] Agent raw payload 携带 `finished_at` 时以相同错误失败。
- [ ] Agent 省略两个时间时，最终发布结果包含 runner 注入值。
- [ ] published result 的 runner 时间与 receipt 一致，且 `finished_at >= started_at`。
- [ ] raw SHA-256 与 published SHA-256 分别记录，不混用。
- [ ] 未声明字段、空可选数组、自由 object 和本地 `sandbox_attestation` 全部被拒绝。
- [ ] B 类引用全部验证存在性、归属、schema、路径边界和 SHA-256。
- [ ] Manager 摘要和 claims 只引用本结果中已验证的 evidence。
- [ ] Developer result 不再携带 AC 状态；`VERIFIED` 仍只能由独立 test/acceptance 流程产生。
- [ ] HUMAN_DECISION_REQUIRED 只消费独立审批请求产物，不消费内联 object。
- [ ] `npm test`、Windows/Linux install dry-run 和 validate 全部通过。
- [ ] 实施交付明确提醒更新已安装 Agent，且不无依据要求安全重装。

## Non-Goals

- 本计划不修改 CommandRecord 自身的命令开始/结束时间所有权；本次 runner 注入只针对顶层 `result.json.started_at` 和 `result.json.finished_at`。
- 本计划不改变 Acceptance Criteria 生命周期或授予 developer-agent `VERIFIED` 权限。
- 本计划不允许 Agent 直接写 Kernel、最终 output、审批状态或 Gate 状态。
- 本计划不迁移或修复已经完成的历史 artifact；历史结果保持不可变。
