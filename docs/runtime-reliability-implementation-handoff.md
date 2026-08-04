# Runtime Reliability Implementation Handoff

> 更新时间：2026-08-04（Asia/Shanghai）  
> 仓库：`D:\MicroConnect\project\openclaw-multi-agent`  
> 当前分支：`feat/runtime-kernel-reliability`  
> 状态：按用户要求暂停；第三阶段 dispatch ledger 尚未提交，工作区有意保持未提交状态。

## 1. 用户目标与不可违反的约束

目标是在当前七 Agent SDLC 框架内提高运行可靠性、Agent 间通信可靠性和 JSON 校验可靠性，并检查/修复 Runtime Guard。实施时必须遵守：

- 不增加或删除 Agent。
- 不改变任何 Agent 的整体职责。
- 允许修改 prompt、`SOUL.md`、`AGENTS.md`、`TOOLS.md`、公共规则和文档。
- 暂不引入 LangGraph。
- 不改 test sandbox 策略。
- 不处理发布后的运维体系。
- 保留当前 Manager + 六个工作 Agent 的既有 SDLC 流程。
- 新建分支实施；每个大改动完成验证后单独 Git commit，方便回滚。

## 2. 分支与已完成提交

当前分支：

```text
feat/runtime-kernel-reliability
```

已经完成并提交两个独立回滚点：

```text
75c5d97 feat: add atomic workflow transaction kernel
5d15e12 fix: harden runtime guard validation boundaries
```

不要重写、squash 或 amend 这两个提交，除非用户明确要求。

### 2.1 提交 `5d15e12`：Runtime Guard 边界加固

主要内容：

- Ajv compiled validator 按 Schema SHA-256 缓存。
- 控制 JSON 文件 regular-file 与 symlink 检查。
- trusted runtime layout 与 realpath 边界检查。
- workflow、active index、event chain、task 控制文件显式拒绝 symlink。
- malformed task/workflow 先做 Schema gating，避免退化为 `GUARD_USAGE_ERROR`。
- 重复 event ID、时间戳倒退、重复 active workflow ID 检查。
- validation excerpt 敏感值脱敏。
- 对应测试已加入。

注意：曾尝试强制所有 event chain 从 `CREATED/INTAKE` 开始，但会破坏历史 fixture，已经撤销。若以后要恢复，只能通过新协议版本或迁移历史数据实现。

### 2.2 提交 `75c5d97`：原子事务与 task/run 历史

新增：

```text
scripts/runtime-core/atomic-store.mjs
scripts/runtime-core/workflow-lock.mjs
scripts/runtime-core/transaction-store.mjs
scripts/runtime-core/task-run-store.mjs
contracts/transaction.schema.json
contracts/task-run.schema.json
```

实现内容：

- workflow 锁记录 nonce、PID、hostname、purpose、时间戳和过期时间。
- 本机死亡 PID 或过期锁可恢复；旧锁保留为 `.stale-*` 证据。
- `state_revision` CAS。
- `PREPARED → APPLYING → COMMITTED` 事务日志。
- staging 文件 fsync + 原子 rename。
- 事务恢复按 SHA-256 幂等滚动完成，且拒绝逃逸 target/staged path。
- 新命令：`commit-transition`、`recover-transactions`。
- 兼容保留 `append-event`，并修复其 stale lock 行为。
- `tasks/<task-id>.json` 是当前 run 指针。
- 历史 run 固化到 `task-runs/<task-id>/<run-id>.json`。
- 有合法 run archive 的历史 artifact 不再报 `ORPHAN_ARTIFACT_RUN`。
- 已覆盖 CAS、锁、非法 journal target、task 指针切换和 6 个崩溃注入点。

该提交完成时全项目测试通过：

```text
Runtime Guard: 97 pass, 2 skipped, 0 fail
Offline Agent JSON harness: 8 pass
Installer validation: 2 pass
```

两个 skipped 都是当前 Windows 会话没有创建符号链接权限，属于预期跳过。

## 3. 当前未提交工作：Dispatch ledger（第三阶段）

当前工作区包含第三阶段实现，尚未 commit。`git status --short` 应看到：

```text
 M README.md
 M docs/agent-contracts.md
 M docs/architecture.md
 M docs/state-and-recovery.md
 M scripts/runtime-guard.mjs
 M tests/runtime-guard.test.mjs
?? contracts/completion-receipt.schema.json
?? contracts/dead-letter.schema.json
?? contracts/dispatch-intent.schema.json
?? contracts/dispatch-receipt.schema.json
?? scripts/runtime-core/dispatch-ledger.mjs
?? docs/runtime-reliability-implementation-handoff.md
```

不要丢弃这些改动，也不要使用 `git reset --hard` / `git checkout --`。

### 3.1 已实现的 dispatch 文件模型

每个 dispatch 保存在：

```text
<workflow>/dispatch/<dispatch-id>/
├── intent.json
├── receipts.jsonl
├── completion-receipt.json
└── dead-letter.json
```

状态语义：

```text
PREPARED → SENT → ACKNOWLEDGED → RUNNING
                                  ├→ SUCCEEDED
                                  ├→ FAILED
                                  └→ LOST → DEAD_LETTER（仅重试耗尽后）
```

已实现并持久化：

- `dispatch_id`。
- `idempotency_key = workflow/task/run/agent/attempt`。
- Agent ID、attempt、session key、session ID。
- input manifest 路径与 SHA-256。
- lease start/deadline。
- retry count / max retries。
- result 路径与 SHA-256。
- completion error code/message。
- dead-letter 原因和 last error。

### 3.2 已实现的新 Runtime Guard 命令

在 `scripts/runtime-guard.mjs` 中已经接入：

```text
prepare-dispatch
record-dispatch-receipt
record-completion-receipt
dead-letter-dispatch
reconcile-dispatch
```

行为概要：

- `prepare-dispatch`
  - 只允许 READY task。
  - 校验 canonical task、context manifest、agent/run/attempt。
  - 在短暂 workflow 锁中恢复未完成事务并创建 intent。
  - 相同幂等键重复调用返回已有 intent。
  - 相同 task/run 的另一个未终结 dispatch 会报 `DISPATCH_SCOPE_CONFLICT`。
  - 不同 task/run 可以分别创建 intent 并并发运行。

- `record-dispatch-receipt`
  - 记录 `SENT` / `ACKNOWLEDGED` / `RUNNING`。
  - receipt append-only。
  - 状态必须单调推进。
  - 同一 dispatch 必须保持同一 session key / session ID。

- `record-completion-receipt`
  - 记录 `SUCCEEDED` / `FAILED` / `LOST`。
  - `SUCCEEDED` 必须绑定已存在的 result 文件并保存 SHA-256。
  - completion 是不可变记录；相同输入可幂等重放，不同输入会冲突。

- `dead-letter-dispatch`
  - 只有 retry budget 已耗尽，且已有 FAILED/LOST completion 才允许写入。

- `reconcile-dispatch`
  - 只读取和报告，不自动 retry、不自动标记 LOST。
  - lease 过期返回 `QUERY_SESSION_BEFORE_RETRY`，要求先查询原 session/history。

### 3.3 已实现的 Guard dispatch 校验

`validateDispatchLedgers()` 已接入 `check-workflow`，当前检查：

- dispatch 目录、文件布局与 symlink/escape。
- 四份新 Schema。
- dispatch ID、receipt ID、幂等键唯一性。
- intent 与 task/current-or-archived-run 的绑定。
- input manifest 路径和 SHA-256 不变性。
- receipt 顺序、时间、session、lease、input hash 绑定。
- completion session、result path/hash、时间绑定。
- dead-letter retry counter 与失败 completion 绑定。
- 同一 task/run 最多一个未终结 dispatch。
- task 状态与最新 dispatch 状态一致性。
- 未终结且 lease 已过期时 `check-workflow` fail-closed，并要求先查原 session。

### 3.4 已加入的 dispatch 测试

`tests/runtime-guard.test.mjs` 已加入：

- intent → SENT/ACKNOWLEDGED/RUNNING → SUCCEEDED 全生命周期。
- prepare 幂等重放。
- 同一 task/run 序列化、不同 task 可创建 dispatch。
- retry 耗尽后 FAILED/LOST → dead letter。
- lease 过期返回 `QUERY_SESSION_BEFORE_RETRY`，且 Guard 报 `DISPATCH_LEASE_EXPIRED`。
- receipt session 篡改应被 Guard 拒绝（测试代码目前放错位置，见下一节）。

在最近一轮结构调整前，dispatch 定向测试曾全部通过：

```text
6 tests, 6 pass, 0 fail
```

## 4. 当前唯一已知测试失败：测试块插入位置错误

最近一次完整 Runtime Guard 测试结果：

```text
103 tests
100 pass
1 fail
2 skipped
```

失败不是生产代码行为，而是测试代码中“篡改 receipt session”块被错误插入到了 transaction 测试。

错误位置：`tests/runtime-guard.test.mjs` 当前约第 1075–1081 行，在测试：

```text
commit-transition archives a superseded run before moving the task pointer
```

错误块使用了该测试作用域中不存在的 `dispatchId`：

```js
const receiptsPath = join(fixture.workflowDir, 'dispatch', dispatchId, 'receipts.jsonl');
const receipts = readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
receipts[1].session_id = 'session-tampered';
writeFileSync(receiptsPath, `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`, 'utf8');
const tampered = checkWorkflow(fixture);
assert.equal(tampered.status, 1);
assert.match(tampered.stdout, /DISPATCH_SESSION_ID_MISMATCH|DISPATCH_COMPLETION_SESSION_MISMATCH/);
```

下一位 Agent 的第一步：

1. 从 transaction 测试中删除上述块。
2. 将它插入测试 `dispatch ledger persists intent, session receipts, completion, and validates against the task` 中，在：

```js
const checked = checkWorkflow(fixture);
assert.equal(checked.status, 0, checked.stdout || checked.stderr);
```

之后、`finally` 之前。该测试作用域中已经定义 `dispatchId`。

然后先运行：

```powershell
node --test --test-name-pattern="dispatch|dead letter|archives a superseded run" tests/runtime-guard.test.mjs
```

## 5. 第三阶段提交前必须完成的检查

修复上面的测试块后，按顺序执行：

```powershell
git diff --check
node --check scripts/runtime-core/dispatch-ledger.mjs
node --check scripts/runtime-guard.mjs
node scripts/runtime-guard.mjs self-check --project-root .
npm run test:runtime-guard
npm test
```

预期：

- self-check contract 数量为 26。
- Windows symlink 测试仍可能跳过 2 个。
- 其余全部通过。

在 commit 前再做一次代码审阅，重点检查：

- `scripts/runtime-core/dispatch-ledger.mjs` 的 symlink/realpath 防护。
- completion/dead-letter 幂等冲突逻辑。
- command 写入前对已有 ledger contract 的校验。
- `validateDispatchLedgers()` 对缺失文件、损坏 JSON/JSONL 是否结构化报错，而不是 `GUARD_USAGE_ERROR`。
- `reconcile-dispatch` 绝不能自动 spawn、自动 retry 或猜测 LOST。
- 不要把 lease 过期直接等价为 session 已丢失。

验证全部通过后，只 stage 当前第三阶段相关文件并提交。建议 commit：

```text
feat: add durable dispatch lifecycle ledger
```

提交文件应包括：

```text
README.md
docs/agent-contracts.md
docs/architecture.md
docs/state-and-recovery.md
docs/runtime-reliability-implementation-handoff.md
scripts/runtime-guard.mjs
scripts/runtime-core/dispatch-ledger.mjs
contracts/dispatch-intent.schema.json
contracts/dispatch-receipt.schema.json
contracts/completion-receipt.schema.json
contracts/dead-letter.schema.json
tests/runtime-guard.test.mjs
```

若交接文档后续还需继续更新，可把它保留到最终文档提交；但不要遗失。

## 6. 第三阶段之后的实施计划

### 6.1 第四阶段：Agent 协议更新（不改变职责）

允许修改 Manager 与工作 Agent 的 `AGENTS.md`、`TOOLS.md`、`SOUL.md`、公共规则和派发 prompt，但不能增删 Agent 或改变角色职责。

Manager 协议需要明确：

- 不再手写关键 workflow/event/active/task 状态；使用 `commit-transition`。
- 新会话恢复时先 `recover-transactions`，再 `reconcile-dispatch`，最后 `recovery-check`。
- spawn 前必须 `check-task-package` + `prepare-dispatch`。
- spawn 返回后立即记录 `SENT` receipt，收到 Agent 启动确认后记录 `ACKNOWLEDGED` / `RUNNING`。
- 工具 timeout 时先按 intent 中 session key/ID 调用 `sessions_list` / `sessions_history` 查询，禁止直接重复 spawn。
- Agent 完成消息只是通知；Manager 必须重新读取 result、结构化输出、Git 和证据。
- result 校验成功后记录 completion receipt，再用事务推进 task/workflow。
- retry 必须增加 attempt（或新 run，按现有状态机规则），不能复用已终结 intent 的幂等键。

工作 Agent 协议需要明确：

- 启动时确认 workflow/task/run/dispatch ID 和 input manifest hash。
- 发送启动 ACK，但聊天 ACK 不是事实源，Manager 要落 receipt。
- 所有输出只写本 run artifact/worktree。
- 先持久化并自检结构化结果，再发送完成通知。
- 若 run 已 superseded 或 lease 已明确失效并被 Manager 终结，停止继续写入。
- 不直接调度其他 Agent，整体职责不变。

需要检查 source Agent 文件与安装/生成机制，优先修改权威 source（`agents/...`、common rules、templates），不要盲目修改历史 runtime/worktree 副本。修改后运行 installer validation。

第四阶段完成后单独提交，建议：

```text
docs: enforce transactional agent communication protocol
```

### 6.2 第五阶段：JSON 契约与确定性 ingestion

计划内容：

- 新增 `config/task-output-contracts.json`，按 task type / agent 声明必须的结构化产物。
- Guard 验证 task 声明与该配置一致。
- 新增确定性 JSON ingestion：
  - 保留 raw 原文。
  - 记录 raw SHA-256。
  - 去除 UTF-8 BOM。
  - 仅当全文恰好是一个 JSON Markdown fence、且 fence 外无其他文本时才 unwrap。
  - 不自动修复 enum、业务字段、ID、状态或结论。
  - 记录执行过的 transformation。
- 加强 JSONL：空文件、单行大小、总大小、尾行、重复 ID 等检查。
- 通过新协议版本加强 ID、schema version、唯一性和条件字段；保留 legacy read 支持，不直接破坏历史 runtime。
- 探测 Gateway 请求级 structured output 能力，但不改 model；如果实际不支持，文档中不得宣称 strict structured output。
- 不引入 LangGraph。

第五阶段完成后单独提交，建议：

```text
feat: harden structured output ingestion and contracts
```

### 6.3 最终阶段：全量回归与交付文档

- 运行 `npm test`。
- 运行 Guard self-check。
- 检查 `git diff --check`、工作区是否干净。
- 审阅 commit 历史，确保每个大改动独立。
- 更新最终架构、恢复流程、Manager 操作手册和兼容性说明。
- 明确记录 2 个 Windows symlink skip（若仍存在）。
- 不增加发布后运维内容，不修改 sandbox 策略。

## 7. 当前计划状态

```text
[completed] 新分支与 Runtime Guard 边界加固
[completed] 原子事务、stale-lock recovery、task/run immutable history
[in progress] dispatch intent/receipt/lease/retry/dead-letter ledger
[pending] Manager 与工作 Agent 协议更新
[pending] JSON output contract 与确定性 ingestion
[pending] 全量回归、文档与最终交付
```

## 8. 常用恢复命令

```powershell
Set-Location 'D:\MicroConnect\project\openclaw-multi-agent'
git branch --show-current
git status --short
git log -5 --oneline
git diff --check
```

不要创建新分支；继续使用：

```text
feat/runtime-kernel-reliability
```

不要重复实现已提交的前两个阶段；从第 4 节所述测试块移动开始继续。
