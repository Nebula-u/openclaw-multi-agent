# StateGraph 人工审批协议

人工审批由代码生成，并通过独立 human capability 写入最新 checkpoint。Manager 和 worker 都不能创建“已批准”事实。

## 审批类型

### ROUTE_PLAN_CONFIRMATION

每轮必有。绑定 `decision_id` 和 `route_hash`，展示实际 steps、固定 Agent 映射、跳过理由和计划中的阶段后审批。只有 `APPROVE` 才冻结路线；`REVISE` 返回 Manager 重新分析；`ABORT` 终止。

### STEP_CONFIRMATION

由冻结路线中的 `human_approval_after` 生成。绑定 `route_hash`、step、task；若 DEVELOPMENT/TEST 产生新 candidate，还绑定该 commit。允许 `APPROVE`、`REWORK` 或 `ABORT`。

### AGENT_DECISION_REQUIRED

Agent 返回 `HUMAN_DECISION_REQUIRED` 时生成。该 pending approval 对象的 `kind` 字段实际值是 `AGENT_DECISION`（不带 `_REQUIRED` 后缀）；`AGENT_DECISION_REQUIRED` 是触发这次生成的 `stop_reason` 值，两者不是同一个字段，读取 checkpoint 时不要混淆。人工决定不能把未过 Gate 的结果直接标为完成，只能携带决定让同一 Agent 重做，或终止。

### ERROR_ESCALATION

同一 task 三次失败后生成。绑定失败 Agent、task、route 和错误摘要。只能批准同一 Agent 开启新批次重试，或终止；不能换 Agent 绕过固定映射。

## 绑定校验

审批命令必须包含：

- 当前 pending `decision_id`；
- 该审批允许的 `choice`；
- 非空 `decided_by`；
- 可选 notes 和 decided_at。

StateGraph 会重新验证 pending approval、route hash、step、task 和 candidate。任何过期、重复、跨 workflow 或 candidate 不匹配的响应都会进入 `HOLD` 或被拒绝。

## CLI 示例

```powershell
node scripts/workflow.mjs snapshot --project-root . --workflow-id WF-example

node scripts/workflow.mjs approve --project-root . --workflow-id WF-example `
  --decision-id DEC-WF-example-ROUTE-abc123 `
  --choice APPROVE `
  --decided-by human:operator `
  --notes "确认本轮路线"
```

用户沉默、Manager 推荐、Agent 自报、文件中出现 `APPROVED` 或 monitor 页面状态都不构成批准。

## 审批后的 candidate

若 step 不产生 commit，批准只推进 step。若 DEVELOPMENT/TEST 产生新 commit，批准时重新计算 candidate patch，并确认 pending approval 中绑定的 commit 与 task result 一致；一致后才写入 candidate history。

## 审计

每次审批请求和解决都会追加 checkpoint 事件，事件包含 decision、route、step、task、candidate 和操作者信息。使用：

```powershell
node scripts/workflow.mjs audit --project-root . --workflow-id WF-example
```

audit 失败时不得继续审批或运行。
