# 本轮工作区修改总结

日期：2026-08-12
范围：`openclaw-multi-agent` 当前工作区相对上一次 Git commit 的未提交修改，以及本轮对 Manager `exec` 配置的回退修复。

## 1. 背景与目标

本轮问题主要集中在三个方面：

1. Windows 下 Agent 派发使用同步进程调用，宿主命令超时后可能留下仍在运行的 Agent、没有 `toolResult` 的会话和无法继续对账的 `RUNNING` 状态。
2. Manager 在 Agent 完成后不能可靠地自动推进 workflow，监控只发现异常，缺少受控唤醒、续跑和结果对账链路。
3. 为处理上述问题而临时加入的 Manager `tools.exec` 审批配置使用了 `security: allowlist` 与 `ask: on-miss`。当模型调用未预授权的命令时，会停在审批/执行握手上，表现为前端长期显示等待或泛化的 `dillydallying`。

本轮修复的目标是：让小型项目所有超时上限不超过 300 秒（5 分钟），让派发和恢复具备可持久化证据，同时将 Manager 的 OpenClaw 配置恢复到原始可用状态，不通过 `exec` 审批绕过本地 Orchestrator。

## 2. 修改内容

### 2.1 Agent 派发改为非阻塞、可恢复的执行链路

涉及：

- `scripts/orchestrator/service.mjs`
- `scripts/orchestrator/agent-process.mjs`
- `scripts/orchestrator.mjs`
- `scripts/orchestrator/workflow-graph/control-adapter.mjs`
- `scripts/control-core/task-repository.mjs`
- `scripts/workflow-runner.mjs`

主要修改：

- `dispatch` 不再同步等待长时间 Agent 进程，而是启动 detached runner 后立即返回 `STARTED`。
- 为每个 dispatch 持久化 launcher、状态、标准输出、错误输出和进程结果定位信息。
- 新增 `dispatch-reconcile --dispatch-id`，只对账原 dispatch，按真实证据补齐 `SENT → ACKNOWLEDGED → RUNNING`、结果摄取和 completion。
- 对没有 launcher 元数据的历史 dispatch 返回 `RECOVERY_REQUIRED`，不根据聊天记录、session transcript 或残留文件伪造成功/失败。
- Windows 启动明确使用 `ComSpec`/`openclaw.cmd` 和显式参数传递，避免 Node `shell:true` 的 quoting 和宿主终止问题。
- workflow graph 在任务处于 `DISPATCHED/RUNNING` 时返回 `RUNNING`，不会重复派发同一个 run。

作用：

- 宿主命令在 5 分钟内结束不再意味着 Agent 状态丢失。
- Orchestrator 可以在下一轮或监控触发时从持久化 launcher 证据继续处理。
- 恢复过程保持幂等、可审计，降低重复派发、伪造 completion 和状态漂移风险。

### 2.2 统一 300 秒硬上限

涉及：

- `config/agent-execution-policy.json`
- `scripts/agent-json-harness/timeout-policy.mjs`
- `monitor/config.mjs`
- `config/monitoring.example.json`
- `scripts/agent-json-harness/llm-runner.mjs`
- `scripts/agent-json-harness/gateway-llm-client.mjs`
- `scripts/agent-llm-contract-tests/run-contract.mjs`
- `scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs`

主要修改：

- Agent 进程超时、dispatch lease、Manager 唤醒、工具运行宽限期和契约测试调用统一采用最多 300 秒。
- 配置或命令行传入超过 300 秒的值直接拒绝（fail-closed），不再由调用方悄悄放宽。
- 监控默认工具宽限期从 900 秒降为 300 秒，并启用 Manager 唤醒和 workflow continuation 配置。

作用：

- 满足小型项目“所有超时不得超过 5 分钟”的约束。
- 防止某个组件单独配置更长等待，重新引入前端卡住或恢复滞后的问题。
- 超时策略集中、可测试，便于部署前检查。

### 2.3 Manager 自动推进、唤醒与监督

涉及：

- `monitor/server.mjs`
- `monitor/wake-adapter.mjs`
- `scripts/orchestrator/workflow-continuation.mjs`
- `scripts/orchestrator/manager-context.mjs`
- `scripts/control-core/audit.mjs`
- `scripts/control-kernel.mjs`
- `scripts/orchestrator/workflow-graph/nodes.mjs`

主要修改：

- 监控增加 supervision repository、watchdog、wake adapter 和 workflow continuation。
- 在 durable `process-result.json` 出现后自动触发 reconcile，并按确定性 graph turn 推进。
- Manager 只在 `NEEDS_TASK`、`HOLD` 或 `FAILED` 等受控 supervision 请求到达时继续工作，不再依赖人工频繁轮询。
- Manager 上下文增加紧凑视图和 token 预算判断，达到软预算时要求开启新 Manager 会话。
- Manager 用户可见输出采用 `summary_only`，隐藏逐工具播报、源码探查、session tail 和模型思考。
- Manager 的 `AGENTS.md`/`TOOLS.md` 明确禁止直接执行 `openclaw.cmd`、轮询 session、手工写 SQLite 或伪造 dispatch/completion；恢复只能通过受支持的 Orchestrator operation。

作用：

- Agent 完成后可以自动进入下一阶段，减少“实际已完成但 Manager 没有推进”的情况。
- 监督动作有冷却、幂等和 durable 证据，避免监控重复唤醒或重复派发。
- 长对话不会无限累积历史，降低上下文超限和误判风险。

### 2.4 Control Kernel 状态和人工决策流补强

涉及：

- `scripts/control-core/task-repository.mjs`
- `scripts/control-kernel.mjs`
- `scripts/control-core/audit.mjs`
- `tests/task-repository.test.mjs`
- `tests/orchestrator.test.mjs`

主要修改：

- workflow 取消会级联到活动 task 和未完成 dispatch，保留原始 artifact/launcher 证据，并使用可审计的 `WORKFLOW_CANCELLED` 结果。
- 人工审批恢复现在区分 `APPROVED`、`REJECTED`、`MODIFIED`，分别进入完成、阻塞或 `NEEDS_REWORK` 状态。
- `NEEDS_REWORK` 允许创建新的 attempt/run/path，旧的成功 dispatch 保持不可变，禁止重派旧 run。
- audit 逻辑识别取消产生的 `LOST` dispatch，避免把受控取消误报为数据不一致。

作用：

- 人工批准、拒绝、修改和取消都成为明确的状态转换，而不是模糊地“恢复任务”。
- 失败返工有新的运行身份和证据链，降低旧结果被覆盖、重复执行或审核边界被绕过的风险。

### 2.5 安装脚本改为原地同步，并补强跨目录调用

涉及：

- `scripts/install.ps1`
- `scripts/install.sh`
- `scripts/validate-install.ps1`
- `scripts/validate-install.sh`
- `README.md`
- `config/openclaw-config-notes.md`

主要修改：

- 普通安装/更新流程优先 `KEEP` 已存在且路径兼容的 Agent，只同步 workspace、规则、模板和受管配置，不删除、不重建 Agent。
- dry-run 和 apply 都使用项目根解析绝对路径，不依赖调用时的当前目录。
- PowerShell 和 Bash 命令示例统一为可直接复制执行的形式，明确 dry-run、apply、校验和 Gateway 启停顺序。
- 校验器增加对 Agent 清单、路径、workspace、配置 schema 和 package catalog 的检查。

作用：

- 避免更新提示词或规则时误删 Agent、误用 `openclaw agents add` 或把路径解析到 `System32`/其他目录。
- Windows PowerShell 与 Linux Bash 的安装行为保持一致，问题更容易复现和定位。

### 2.6 回退 Manager 的 `exec` 配置，恢复原始委派配置

涉及：

- 当前 OpenClaw 配置：`C:\Users\liuxu\.openclaw\openclaw.json`
- `scripts/install.ps1`
- `scripts/install.sh`
- `scripts/validate-install.ps1`
- `scripts/validate-install.sh`
- `config/openclaw-config-notes.md`
- `docs/native-openclaw-integration.md`
- `tests/validate-install.test.mjs`

恢复后的 Manager 关键配置为：

```json
{
  "subagents": {
    "delegationMode": "prefer",
    "allowAgents": [
      "architect-agent",
      "developer-agent",
      "release-agent",
      "requirement-agent",
      "review-agent",
      "test-agent"
    ],
    "requireAgentId": true
  }
}
```

同时确认 Manager 对象中不存在 `tools` 字段，不再写入以下临时配置：

```text
tools.exec.security = allowlist
tools.exec.ask      = on-miss
```

为什么必须回退：

- `ask: on-miss` 会把未预授权的命令送入审批等待；如果 UI 没有及时显示或处理 pending approval，session 只留下 tool call，Manager 仍保持 `running`。
- 项目既有规则要求 Manager 通过本地 `scripts/orchestrator.mjs` 调度，而不是直接调用普通 shell 命令。临时开放 `exec` 会造成配置边界与提示规则不一致。
- 恢复原始 `subagents` 后，Manager 的 worker 委派能力与安装前备份一致；派发仍由项目既有的受控 Orchestrator 链路负责。

作用：

- 消除本轮由 exec 审批握手造成的卡死根因。
- 保留原有 Manager → worker 委派能力，不改变 worker 白名单和 `requireAgentId` 约束。
- 安装器和文档不会在下一次同步时再次写回临时 `tools` 配置。

## 3. 为什么这样修改

这些修改共同解决的是“长任务执行、状态持久化、自动推进和权限边界”四个相互关联的问题：

1. 先把长进程从 Manager 请求的同步等待中剥离，避免宿主超时直接破坏状态链路。
2. 再把 launcher、process result 和 completion 变成可读取的持久化事实，让下一轮能够对账而不是猜测。
3. 用 watchdog/wake/continuation 连接监控与 Orchestrator，解决“任务已完成但没人推进”的空档。
4. 最后收紧 Manager 的实际工具边界并恢复原始配置，避免模型通过普通 `exec` 绕过 Orchestrator，或因为审批未处理而停在半完成状态。

此外，示例 Todo worktree 中删除了未使用的 `framer-motion` 导入和未使用的 `allTags` 局部变量。这是小范围的编译/静态检查清理，不改变业务行为，也不影响 Orchestrator 状态链路。

## 4. 验证结果

本轮已执行并通过：

- `openclaw config validate --json`
- `openclaw gateway status`：Gateway 运行中，连接探测通过
- `node --test tests/validate-install.test.mjs`：4 项通过
- `bash -n scripts/install.sh scripts/validate-install.sh`
- PowerShell 安装器和校验器语法解析
- PowerShell 安装器 dry-run：7 个 Agent 均显示 `KEEP`，Manager 白名单为 6 个 worker
- `git diff --check`

Manager 当前配置与 `runtime/control/config-snapshots/openclaw.json.20260811-165432.bak` 中的 Manager 配置比较：

- `tools` 字段：当前不存在，原始配置也不存在
- `subagents`：完全一致

## 5. 工作区状态与注意事项

- 本轮没有执行 Git commit，也没有暂存文件。
- 工作区中其他与超时、Orchestrator、监控、测试、文档和示例项目有关的未提交修改均保留。
- `runtime/control/config-snapshots/`、`tmp/` 和取证文件未删除。
- 如果后续需要再次修改 Manager 工具权限，应先通过 OpenClaw schema 和审批 UI 验证完整握手流程，并同步更新 Manager 的 `AGENTS.md`、安装器和校验测试；不能只修改 live config。
