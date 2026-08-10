# JSON Schema 校验、清洗与重写：代码级执行流程

> 报告日期：2026-08-06
>
> 目的：从代码入口说明 JSON/JSONL 产物如何经过任务声明、派发前检查、Agent 输出、清洗、Schema 校验、重写、结果摄取和 workflow 状态推进。
>
> 重要边界：当前代码存在两条相关但不同的路径：
>
> 1. `scripts/agent-json-harness/`：用于真实 Gateway LLM 回复的清洗、校验、分类重写和失败收集，自动重试已实现。
> 2. `Control Kernel + Runtime Guard`：用于生产 workflow 的文件产物、任务完成和状态迁移，严格校验和失败关闭已实现；生产路径的所有自动重写尚未统一封装成不可绕过的 Kernel API。

## 一、先看完整调用链

### A. LLM 回复 Harness 路径

```text
collect-llm-failures.mjs
  └─ runLlmCase()
      ├─ Gateway client.send(agentId, sessionKey, prompt)
      ├─ validateLlmResponse()
      │   ├─ ingestJsonText()       清洗/解析
      │   └─ runtime-guard validate-file  Schema 校验
      ├─ 通过 → 返回 PASSED_FIRST / REPAIR_RETRY_SUCCEEDED
      └─ 失败 → classifyLlmFailure()
                 └─ buildJsonRepairPrompt()
                     └─ 同一 session 最多重试 2 次
```

### B. 生产 workflow 文件产物路径

```text
Manager
  ├─ 创建 task + structured_outputs[]
  ├─ task-validate / check-task-package
  ├─ dispatch-prepare → Control Kernel 写入 intent/outbox/task
  ├─ sessions_spawn → Agent 写 output/*.json[ l ]
  ├─ validate-file + check-workflow
  └─ result-ingest
       ├─ 严格读取和 Ajv 校验所有声明产物
       ├─ 通过 → 根据 result_status 更新 task
       └─ 失败 → 不提交完成事务；由 Manager 按协议进入 NEEDS_REWORK/FAILED/HOLD
```

核心原则是：Agent 负责生成内容，宿主侧负责判定内容是否可信，Control Kernel 负责接受或拒绝状态变更。

## 二、参与者、触发者和控制者

| 环节 | 触发者 | 实际代码 | 控制者 | 接收者/结果 |
|---|---|---|---|---|
| 任务定义 | Manager | `task.json`、`structured_outputs[]` | Runtime Guard / task repository | Control Kernel task 表 |
| 派发前检查 | Manager | `check-task-package`、`task-validate` | Runtime Guard + Ajv + task policy | 通过后才能 `READY`/派发 |
| Agent 调用 | Manager/OpenClaw Gateway | `client.send()` 或 `sessions_spawn` | Manager 派发协议、dispatch ledger | 指定 `agentId` 的 Agent session |
| 回复清洗 | Harness 接收器 | `ingestJsonText()` | 纯 Node 确定性逻辑 | 清洗后的临时 JSON/JSONL |
| 单文件 Schema 校验 | Harness/Manager | `validate-file` | Runtime Guard + Ajv | `ok=true` 或结构化 errors |
| 重写触发 | Harness runner 或 Manager 协议 | `classifyLlmFailure()`、`buildJsonRepairPrompt()` | 固定 retry budget | 同一 Agent session |
| 结果接收 | Manager | `result-ingest` | Control Kernel task repository | task 状态、task run、task event |
| 阶段推进 | Manager | `commit-transition`/Kernel reducer | Gate + Runtime Guard | 下一 workflow phase 或 HOLD |

Agent 的 `self_validation` 只能作为结果字段或辅助信息，不能替代宿主侧校验。

## 三、步骤 1：任务声明结构化输出

### 触发与控制

Manager 在派发任务前创建 `task.json`，并在 `structured_outputs[]` 中声明所有下游会读取的 JSON/JSONL。

关键规则在 [agents/manager-agent/workspace/AGENTS.md](D:\MicroConnect\project\openclaw-multi-agent\agents\manager-agent\workspace\AGENTS.md) 中，要求每项包含：

```text
path_abs
schema_path_abs
format
required
producer
```

关键代码位于 [scripts/runtime-guard.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\runtime-guard.mjs) 的 `validateStructuredOutputs()`：

```js
for (const entry of task.structured_outputs ?? []) {
  if (entry.producer !== task.assigned_agent) {
    errors.push(issue('STRUCTURED_OUTPUT_PRODUCER_MISMATCH', ...));
  }
  if (!isAbsolute(entry.path_abs)
    || !isPathLexicallyWithin(outputRoot, entry.path_abs)
    || (existsSync(entry.path_abs) && !isRealPathWithin(outputRoot, entry.path_abs))) {
    errors.push(issue('STRUCTURED_OUTPUT_PATH_ESCAPE', ...));
  }
  if (!isAbsolute(entry.schema_path_abs) || !isRealPathWithin(contractsRoot, entry.schema_path_abs)) {
    errors.push(issue('STRUCTURED_OUTPUT_SCHEMA_ESCAPE', ...));
  }
}
```

这里不是 Agent 自由声明结果。Manager 先声明，Guard 检查声明是否可信，Agent 只能按已经分配的 output contract 写入。

## 四、步骤 2：派发前校验任务包

### 触发与控制

Manager 在调用 `sessions_spawn` 之前触发：

```text
node scripts/runtime-guard.mjs check-task-package ...
```

入口位于 [scripts/runtime-guard.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\runtime-guard.mjs) 的 `checkTaskPackageCommand()`。

它会检查：

- task Schema 和 workflow/task 身份
- context manifest 是否存在且符合 Schema
- 输入文件是否存在、SHA-256 是否匹配
- worktree、artifact、context 路径是否为绝对路径
- task type 与 assigned Agent 是否匹配
- 输出 Schema 是否位于项目 `contracts/` 下
- 必需 `result.json`、`evidence.jsonl`、`command-records.jsonl` 是否已声明
- 依赖任务是否已完成

关键失败分支：

```js
if (errors.length > 0) {
  appendGuardFailureLog(options, taskFile, errors);
  emit({
    ok: false,
    command: 'check-task-package',
    effective_status: 'HOLD',
    errors,
  }, 1);
  return;
}
```

因此，派发前校验失败时，不应写 `TASK_DISPATCHED`，也不应创建 Agent session。

同一类校验也存在于 [scripts/control-core/task-repository.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\control-core\task-repository.mjs) 的 `validatePackage()`，用于 Control Kernel 的 task `CREATED → READY` 迁移。

## 五、步骤 3：Manager 派发 Agent

### 触发与控制

Manager 完成 task package 校验后，调用 Control Kernel 的 `dispatch-prepare`：

```js
prepareDispatch(intent) {
  assertValid(validators.intent, intent, 'DISPATCH_INTENT_SCHEMA_INVALID');
  return transactional(database, `DISPATCH:${intent.dispatch_id}`, intent, () => {
    const task = loadTask(database, intent.task_id);
    if (!task || task.status !== 'READY') {
      fail('DISPATCH_TASK_NOT_READY', 'dispatch requires a READY task');
    }
    // 检查 workflow/task/run/agent/attempt/input manifest
    // 写入 dispatch intent、outbox，并将 task 改为 DISPATCHED
  });
}
```

代码位于 `task-repository.mjs` 的 `prepareDispatch()`，CLI 入口位于 [scripts/control-kernel.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\control-kernel.mjs) 的 `dispatch-prepare` 分支。

然后 Manager 才调用 OpenClaw 的 `sessions_spawn`。真实 session 的状态由 receipt 对账：

```text
PREPARED → SENT → ACKNOWLEDGED → RUNNING
```

Agent 不能自己把 dispatch 改成 `RUNNING`；必须由 Manager 记录真实 session receipt，Control Kernel 才接受状态变化。

## 六、步骤 4：Agent 生成 JSON/JSONL

### Agent 做什么

Agent 收到最小上下文、任务文件、Schema 和输出路径后，负责：

- 完成自己的业务任务
- 写入声明的 `output/result.json`
- 写入声明的 JSONL 证据或命令记录
- 在结果中填写 `result_status`、身份、路径和证据引用

### Agent 不能做什么

Agent 不能：

- 自己宣布任务已完成并推进 workflow
- 修改 task 的 assigned Agent、Schema 或 output contract
- 把聊天文本当作最终结果
- 绕过 `validate-file`、`check-workflow` 或 `result-ingest`

Manager 规则明确要求：不能仅凭 Agent 的 Markdown 总结更新 task 状态。

## 七、步骤 5：LLM 回复清洗

### 适用路径

清洗主要用于 Gateway LLM 回复接收路径，由 [scripts/agent-json-harness/runtime-guard-client.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\runtime-guard-client.mjs) 调用：

```js
ingestion = ingestJsonText(response, {
  jsonl: Boolean(scenario.jsonl),
});
content = ingestion.text;
```

核心实现位于 [scripts/runtime-core/json-ingestion.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\runtime-core\json-ingestion.mjs) 的 `ingestJsonText()` 和 `normalizeText()`。

### 允许的清洗

```js
const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;

const fenced = unwrapSingleFence(withoutBom);
if (fenced !== null) {
  transformations.push('UNWRAP_SINGLE_JSON_FENCE');
  return { text: fenced.trim(), transformations };
}

// 原文不是完整 JSON 时，尝试提取唯一完整 JSON/JSONL
text = jsonl
  ? extractUniqueJsonlBlock(withoutBom)
  : extractUniqueJsonValue(withoutBom);
```

### 明确拒绝的情况

```js
if (candidates.length > 1) {
  throw new JsonIngestionError(
    'Response contains more than one complete JSON value; refusing to guess.',
    'AMBIGUOUS_JSON_VALUES',
  );
}
```

清洗不会：

- 补必需字段
- 修改业务字段
- 把字符串改成数字
- 把非法枚举改成合法枚举
- 从多个候选 JSON 中选择一个

每次清洗都记录 `raw_sha256`、`cleaned_sha256` 和 `transformations`，方便判断系统到底改了什么。

## 八、步骤 6：Runtime Guard + Ajv Schema 校验

### Harness 路径

`runtime-guard-client.mjs` 会把清洗后的内容写入临时文件，然后调用 Runtime Guard：

```js
writeFileSync(artifact, content, 'utf8');
const args = [
  'validate-file',
  '--schema', schemaPath,
  '--file', artifact,
];
return invoke(args);
```

`invoke()` 实际执行：

```js
spawnSync(process.execPath, [GUARD, ...args], {
  cwd: PROJECT_ROOT,
  encoding: 'utf8',
});
```

Runtime Guard 的 `validate-file` 会：

1. 读取 Schema。
2. 解析 JSON 或 JSONL。
3. 使用 Ajv 校验每条记录。
4. 检查 JSONL 非空和 ID 唯一性。
5. 失败时写入结构化 validation error log。
6. 返回 `ok=false` 和错误码。

关键失败返回：

```js
if (errors.length > 0) {
  appendValidationFailureLog(options, schemaPath, filePath, errors);
  emit({
    ok: false,
    command: 'validate-file',
    validator: VALIDATOR_NAME,
    errors,
  }, 1);
  return;
}
```

### 生产 workflow 路径

生产任务接收结果时，Control Kernel 的 `validateOutputs()` 会直接读取任务声明的每一个文件：

```js
for (const output of task.structured_outputs) {
  if (!existsSync(output.path_abs)) {
    if (output.required) fail('TASK_REQUIRED_OUTPUT_MISSING', ...);
    continue;
  }

  const validate = compile(readJson(output.schema_path_abs));
  const values = output.format === 'json'
    ? [readJson(output.path_abs)]
    : readFileSync(output.path_abs, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map(JSON.parse);

  for (const value of values) {
    assertValid(validate, value, 'TASK_OUTPUT_SCHEMA_INVALID');
  }
}
```

这里是严格读取，不会自动修复文件内容。文件已经写入任务 artifact 后，生产路径要求其本身合法。

## 九、步骤 7：错误分类与重写提示

### 触发者

触发者是 `runLlmCase()`，不是 Agent。

代码位于 [scripts/agent-json-harness/llm-runner.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\llm-runner.mjs)：

```js
const result = await attempt({
  client,
  scenario,
  testCase,
  runId,
  prompt,
  attemptNumber,
  timeoutMs,
});

if (result.validation.ok) {
  return {
    classification: attemptNumber === 1
      ? 'PASSED_FIRST'
      : 'REPAIR_RETRY_SUCCEEDED',
  };
}

finalClassification = classificationFor(result);
prompt = buildJsonRepairPrompt({
  classification: finalClassification,
  errors: result.validation.errors ?? [],
  retryNumber: attemptNumber,
});
```

错误分类在 [scripts/agent-json-harness/json-repair-prompts.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\json-repair-prompts.mjs) 完成：

```js
if (response.trim().length === 0) return 'EMPTY_RESPONSE';
if (ingestionError?.diagnostic === 'OUTPUT_TRUNCATED') {
  return 'OUTPUT_TRUNCATED';
}
if (keywords.includes('enum')) return 'ENUM_VIOLATION';
if (keywords.includes('type')) return 'TYPE_VIOLATION';
return 'SCHEMA_DRIFT';
```

重写提示由代码固定生成，例如：

```text
JSON_REWRITE_REQUEST kind=TYPE_VIOLATION retry=1/2.
只返回一个完整的 JSON 对象；不得输出 Markdown、解释或前后缀。
仅修正诊断指向的字段，其它事实保持不变。
```

因此 Agent 只能响应宿主给出的重写请求，不能自行决定重试次数、错误分类或放宽 Schema。

## 十、步骤 8：同一 session 重试

`runLlmCase()` 的重试循环是：

```js
for (
  let attemptNumber = 1;
  attemptNumber <= MAX_REPAIR_RETRIES + 1;
  attemptNumber += 1
) {
  // 调用 Agent → 清洗 → Schema 校验
}
```

其中：

```js
const MAX_REPAIR_RETRIES = 2;
```

session key 由 scenario、run、case 固定生成：

```js
return `agent:${scenario.agentId}:llm-json-${runId}-${scenario.name}-${testCase.id}`;
```

这意味着：

- 第一次调用失败后，仍使用同一个 Agent session
- 最多额外重写两次
- 成功后停止重试
- 两次后仍失败，返回 `RETRY_FAILED` 或 `EMPTY_RETRY_FAILED`

失败收集器 [scripts/agent-json-harness/collect-llm-failures.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\collect-llm-failures.mjs) 会保存每次 prompt、原始回复、Guard 报告、错误分类和摘要。

## 十一、步骤 9：生产结果摄取与状态推进

### 触发入口

Manager 在 Agent session 完成后，生成 completion receipt，然后调用：

```text
node scripts/control-kernel.mjs result-ingest --completion-file <file>
```

CLI 入口位于 [scripts/control-kernel.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\control-kernel.mjs)：

```js
} else if (command === 'result-ingest') {
  emit(tasks.ingestCompletion(
    JSON.parse(readFileSync(resolve(required(options, 'completion-file')), 'utf8')),
  ));
}
```

### 接收和验收

`ingestCompletion()` 会先验证 completion receipt 的 Schema，再检查：

- dispatch 是否存在
- completion 身份是否匹配 intent
- session ID 是否是原始 spawn session
- dispatch 是否已经进入 `RUNNING`
- result 文件是否存在
- result 文件 SHA-256 是否匹配
- 所有结构化输出是否存在并符合 Schema
- result 中的 workflow/task/run/agent/attempt 是否一致

通过后才计算目标状态：

```js
if (completion.status === 'FAILED') nextStatus = 'FAILED';
else if (completion.status === 'LOST') nextStatus = 'LOST';
else {
  nextStatus = ({
    COMPLETED: 'COMPLETED',
    NEEDS_REWORK: 'NEEDS_REWORK',
    BLOCKED: 'BLOCKED',
    HUMAN_DECISION_REQUIRED: 'WAITING_HUMAN',
    FAILED: 'FAILED',
  })[validated.result.result_status];
}
```

整个更新在事务中完成：

```js
return transactional(database, `COMPLETION:${completion.completion_id}`, completion, () => {
  // 更新 dispatch
  // 更新 task
  // 写入 task_run.result_json
  // 写入不可变 task event
});
```

校验失败会在事务提交前抛出 `ControlTransitionError`，因此不会出现“结果非法但任务已 COMPLETED”的状态。

## 十二、步骤 10：Gate 和 workflow 阻断

即使 task result 通过，Manager 仍需执行 workflow Guard 和 Gate：

```text
result-ingest 成功
  → 写阶段 Gate
  → Runtime Guard check-workflow
  → Gate 无阻断项且 check-workflow ok=true
  → commit-transition 推进 workflow
```

Manager 规则明确要求：

```text
Guard 失败 → 不 spawn、不 merge、不推进、不宣布完成
```

如果重写后仍失败，生产协议要求：

```text
task → NEEDS_REWORK / FAILED / LOST
workflow → HOLD（按具体故障）
保留原始 result 和 validation error，不覆盖历史证据
```

因此，清洗和重写只解决“输出格式/契约层”的问题；它们不能跳过审批、Gate、Git、路径、身份、session 或状态机校验。

## 十三、两条路径的当前实现差异

| 能力 | LLM Harness | 生产 Control Kernel workflow |
|---|---|---|
| 清洗 BOM/fence/唯一 JSON | 已实现，`ingestJsonText()` | `result-ingest` 不自动清洗已落盘业务文件 |
| Schema 校验 | 已实现，清洗后调用 `validate-file` | 已实现，`validateOutputs()` 严格解析并 Ajv 校验 |
| 错误分类 | 已实现，空输出/截断/enum/type/schema drift | 主要返回结构化 Control Kernel/Guard 错误码 |
| 自动重写 | Harness 已实现，首次调用外最多两次 | Manager 协议要求执行，但尚未统一成不可绕过的 Kernel 自动重写 API |
| 失败后的状态 | Harness 返回失败分类并打包证据 | task 进入 `NEEDS_REWORK`/`FAILED`/`BLOCKED`/`LOST`，workflow 按情况 HOLD |
| 是否允许 Agent 自主放行 | 不允许 | 不允许 |

## 十四、最终责任边界

```text
Agent：生成业务结果、按提示重写指定 JSON 文件
Manager：创建任务、派发、接收回执、触发校验/重写、提交状态推进
Gateway：承载 Agent session，不决定项目状态
JSON ingestion：只做确定性格式归一化
Runtime Guard/Ajv：判断 JSON/Schema/上下文/Gate 是否可信
Control Kernel：事务化接受或拒绝 task/dispatch/result/status 变化
Gate：判断是否允许进入下一阶段
```

一句话总结：Agent 可以产生“候选结果”，但只有 workflow 触发的 Guard 校验、结果摄取和 Gate 全部通过，Control Kernel 才会接受它为正式状态。

## 十五、相关代码入口索引

- LLM 调用与重试：[scripts/agent-json-harness/llm-runner.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\llm-runner.mjs)
- 重写提示与错误分类：[scripts/agent-json-harness/json-repair-prompts.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\json-repair-prompts.mjs)
- LLM 回复接收和 Guard 调用：[scripts/agent-json-harness/runtime-guard-client.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\agent-json-harness\runtime-guard-client.mjs)
- JSON/JSONL 确定性清洗：[scripts/runtime-core/json-ingestion.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\runtime-core\json-ingestion.mjs)
- Runtime Guard：[scripts/runtime-guard.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\runtime-guard.mjs)
- Control Kernel CLI：[scripts/control-kernel.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\control-kernel.mjs)
- task/dispatch/result 验收：[scripts/control-core/task-repository.mjs](D:\MicroConnect\project\openclaw-multi-agent\scripts\control-core\task-repository.mjs)
- Manager 执行协议：[agents/manager-agent/workspace/AGENTS.md](D:\MicroConnect\project\openclaw-multi-agent\agents\manager-agent\workspace\AGENTS.md)
