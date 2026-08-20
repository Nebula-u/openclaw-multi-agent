# Manager-Agent 编排与执行协议整改计划

日期：2026-08-05
分支：`dev`
范围：Manager-Agent、Control Kernel、派发协议、JSON 写入、Windows 执行与恢复

> **实施状态同步（2026-08-06）：待开始。** 截至本次核对，此计划创建后的 Git 历史没有对应的功能实现提交；因此第 0–8 轮及最终验收标准均不得视为完成。P0–P5 Control Kernel 已提供 workflow/task/run/dispatch、Schema、outbox、审计与恢复基础，但不等同于本计划要求的计划持久化回执、Intake 分流、pre-spawn `agentId` 校验、不可绕过派发、统一 JSON 原子写入或 Windows 锁恢复已经实现。

> **下周执行顺序：** 先完成第 0 轮并记录失败基线；随后优先第 1–5 轮，形成“可确认计划 → 执行实体初始化 → Agent 身份 → 不可绕过派发 → 原子 JSON 写入”的最小闭环；第 6–7 轮处理 Windows 参数/锁与中断恢复；最后才执行第 8 轮完整回归和 README 收尾。每轮必须有独立提交、定向测试、`git diff --check` 与 Changelog 记录。

## 一、目标与约束

本计划针对最新一轮审计发现的以下问题进行代码层整改：

1. `sessions_spawn` 缺少 `agentId`，失败后重复使用相同错误参数。
2. Manager 跳过 context package、approval assessment、task package check、prepare-dispatch 和状态提交。
3. JSON 文件编辑后未及时执行语法和 Schema 校验，曾遗留 `package.json` 尾部逗号。
4. PowerShell、`node -e` 和嵌套引号造成参数转义、语法和 UTF-8 输出问题。
5. Windows 下 Puppeteer 中断后句柄未释放，产生 `EBUSY`、乱码和错误退出码。
6. 计划状态更新只依赖 `update_plan` 返回值或内存状态，缺少 revision 和持久化确认。
7. 未建立 workflow/task/run 就直接执行；Intake 未区分标准 SDLC 与轻量原型任务。

实施约束：

- 优先使用代码、Schema、事务和状态机约束，不依赖单纯修改 Prompt。
- Control Kernel 事件作为计划、workflow、task、run、dispatch 和 result 的唯一事实来源。
- 所有实际执行请求必须先建立最小执行上下文。
- 标准 SDLC 使用完整审批和 Gate；轻量原型可以简化，但不能退化为普通聊天，至少要有最小 workflow、task、run 和 result 记录。
- 每轮修改后运行定向测试、`git diff --check`，更新 `CHANGELOG.md` 并单独提交。
- `README.md` 只在全部代码整改和完整回归通过后更新。
- 保留当前工作区已有的 `projects/taskflow` 删除变更，不恢复、不修改、不纳入本次提交。

## 二、执行轮次

### 第 0 轮：基线确认

本轮不修改文件、不创建提交。

检查内容：

- 当前分支和工作区状态。
- 现有 workflow/task/run、Control Kernel 事件和计划状态实现。
- 所有直接调用 `sessions_spawn`、直接写 JSON、使用 `node -e` 和创建旁路目录的路径。
- 现有测试以及修改前的失败基线。

输出基线测试结果和代码入口清单，确保后续新增失败来自明确的回归用例。

### 第 1 轮：计划持久化与可确认回执

对应问题：计划状态不可确认，`update_plan` 返回空内容，没有 revision 或持久化确认。

建立 Manager 侧的计划持久化协议。原生 `update_plan` 工具的返回格式不由本仓库控制，因此在 Manager/Control Kernel 适配层补充可验证回执，不能把空返回视为成功。

每次计划更新必须：

1. 校验 plan ID、当前 revision 和目标状态。
2. 事务追加 `PLAN_UPDATED` 事件。
3. 生成递增 revision 和 event ID。
4. 回读 Control Kernel 的计划状态。
5. 对比 revision、状态和 event ID。
6. 只有回读一致时才返回 `persisted: true`。

回执至少包含：

```json
{
  "planId": "plan-xxx",
  "revision": 3,
  "status": "persisted",
  "eventId": "evt-xxx",
  "persisted": true,
  "source": "control-kernel"
}
```

增加 `pending`、`persisting`、`persisted`、`failed`、`stale` 状态，使用乐观并发控制和幂等键。事件写入成功但回读不一致时必须报告未确认，禁止继续依赖未确认的计划状态。

测试：成功回执、空响应失败、回读不一致、revision 冲突、重复提交幂等以及进程重启后的事件恢复。

建议提交：

```text
fix(plan): persist plan revisions through control-kernel events
```

### 第 2 轮：Intake 分流与执行前实体初始化

对应问题：未建立 workflow/task/run 就直接执行，原型任务被当作普通聊天处理。

统一执行前流程：

```text
Intake → Workflow → Task → Run → Approval/Gate → Execution
```

Intake 至少判断：

- 是否需要代码或文件修改。
- 是否需要派发子 Agent、调用命令或外部工具。
- 是否需要审批。
- 任务风险等级和所需 Gate。
- 任务类型：`standard_sdlc` 或 `lightweight_prototype`。

任何需要执行的请求都不能在 workflow、task、run 缺失时调用命令、浏览器或 spawn。

标准 SDLC 必须建立 context package、approval assessment、task package、Gate、事件链、receipt/result 和审计记录。

轻量原型允许缩减审批和 Gate，但至少建立：

- 最小 workflow。
- task 和 run。
- Intake 分类事件。
- 最小审批评估或策略自动批准记录。
- 最小 acceptance gate。
- 执行事件、result 记录和完成/失败事件。

普通聊天只有在不产生文件修改、不调用外部工具、不派发 Agent 时才可不建立执行型 workflow。

测试：标准 SDLC 完整链路、轻量原型最小链路、未初始化实体时拒绝执行、分类结果影响后续 Gate、分类修正有审计记录以及普通聊天不误建执行任务。

建议提交：

```text
feat(intake): classify workflows and initialize execution context
```

### 第 3 轮：`sessions_spawn` Agent 身份防线

在真实 spawn 前强制执行 `agents_list` 或等效 Agent 注册表校验，并创建结构化 dispatch intent。

强制条件：

- `agentId` 存在且非空。
- `agentId === assigned_agent`。
- Agent 属于允许派发列表。
- task、workflow、run、dispatch intent 的 Agent 身份一致。

为错误参数建立指纹和幂等保护。确定性失败后禁止未经修正的原样重试；修正参数后必须产生新的合法 dispatch 尝试和审计事件。

测试：缺少 Agent、Agent 不匹配、Agent 不存在、原样重试和修正后重试。

建议提交：

```text
fix(dispatch): validate agent identity before session spawn
```

### 第 4 轮：不可绕过的派发状态机

将底层 spawn 收为内部能力，只暴露统一的派发编排 API。标准流程为：

1. 验证 workflow/task/run。
2. 读取 Intake 类型和风险级别。
3. 生成 context package。
4. 执行 approval assessment。
5. 执行 `check-task-package`。
6. 执行 `prepare-dispatch`。
7. 在事务中创建 dispatch intent、更新 task 和 outbox。
8. 调用真实 `sessions_spawn`。
9. 记录 session receipt。
10. 推进 `SENT → ACKNOWLEDGED → RUNNING`。
11. 通过 result ingestion 完成任务。

禁止无审批、无 Gate、无 dispatch intent 或无 receipt 的越级状态迁移。spawn 失败必须进入明确的失败或可重试状态，不能进入 `RUNNING`，也不能伪装成未执行。

所有迁移以 Control Kernel 事件为事实来源，支持幂等和恢复。

建议提交：

```text
fix(orchestration): enforce auditable dispatch state machine
```

### 第 5 轮：JSON Schema 校验与原子写入

建立统一 JSON 写入模块，禁止业务代码直接拼接 JSON 文本。

写入流程：

1. 对内存对象执行 AJV Schema 校验。
2. `JSON.stringify` 序列化。
3. 对序列化文本执行 `JSON.parse`。
4. 写入同目录临时文件。
5. 回读临时文件并再次解析、校验。
6. 原子替换正式文件。

失败时保留旧文件，不留下半写入文件。覆盖 `package.json`、task/context package、dispatch intent、receipt、result、Gate 和状态审计产物。

测试尾部逗号、截断 JSON、非法转义、Schema 字段错误、写入中断、合法回读以及仓库 JSON 批量检查。

建议提交：

```text
fix(json): enforce schema-validated atomic writes
```

### 第 6 轮：Windows 命令参数和 UTF-8 边界

将复杂 `node -e` 逻辑迁移到独立 `.mjs` 文件，统一使用参数数组、stdin 或临时 JSON 文件传递复杂数据。

建立统一 process runner，标准化 UTF-8、stdout/stderr、退出码、超时、signal，并区分环境错误和业务错误。PowerShell 显式设置 UTF-8 输出，不依赖默认代码页。

测试中文路径、空格路径、引号、反斜杠、JSON 参数、非零退出码、超时和中断。

建议提交：

```text
fix(exec): harden Windows command execution and encoding
```

### 第 7 轮：Windows 文件锁与中断恢复

为 browser、page、子进程和文件操作增加统一 `finally` 清理，覆盖正常退出、异常退出、超时和中断。

安装或覆盖依赖前检查相关进程和目标目录。对 `EBUSY`、`EPERM` 等短暂锁冲突执行有限次数退避重试；持续锁定时输出具体路径和诊断信息。

禁止通过创建 `travel-agent2`、副本目录等旁路路径规避失败。恢复必须依赖 workflow/task/run 和事件状态，避免重复派发或重复生成结果。

测试短暂锁恢复、永久锁定、进程清理、中断恢复、无旁路目录和重试幂等性。

建议提交：

```text
fix(windows): recover safely from locks and interrupted processes
```

### 第 8 轮：完整回归与 README 收尾

前七轮全部通过后：

- 运行完整测试套件和五类问题组合场景。
- 验证标准 SDLC 与轻量原型两条流程。
- 验证计划 revision、事件持久化和重启恢复。
- 批量解析和 Schema 校验 JSON 文件。
- 检查非法状态跳转、直接 spawn、高风险 `node -e` 和旁路目录路径。
- 更新 `README.md`，说明 Intake 分流、workflow/task/run 要求、计划确认、Agent 派发、JSON 写入和 Windows 恢复机制。
- 同步更新 `CHANGELOG.md` 并完成最终提交。

建议提交：

```text
docs: document hardened orchestration and recovery workflow
```

## 三、最终验收标准

- 计划更新能返回 plan ID、revision、状态、event ID 和持久化结果。
- 空返回、回读不一致或 revision 冲突不会被误判为成功。
- Control Kernel 事件是计划和执行状态的唯一事实来源。
- 所有执行请求在执行前都有 workflow/task/run。
- 标准 SDLC 具有完整审批、Gate、事件链、receipt/result 和审计依据。
- 轻量原型至少具有最小 workflow、task、run 和 result 记录。
- `agentId` 缺失或不匹配时不会到达真实 `sessions_spawn`。
- 派发协议不能被直接 spawn 绕过。
- 非法 JSON 或 Schema 错误不会落盘覆盖原文件。
- Windows 参数、中文编码、文件锁和进程中断均有确定处理。
- 不会通过 `travel-agent2` 等旁路目录规避失败。
- 每轮代码修改都有独立 Git commit 和 CHANGELOG 记录。
- README 只在完整验证通过后修改。
- `projects/taskflow` 现有用户变更不进入本次提交。
