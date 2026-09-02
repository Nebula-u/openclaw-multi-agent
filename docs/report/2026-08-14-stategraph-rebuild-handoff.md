# StateGraph + Checkpointer 单框架重建交接

> 日期：2026-08-14  
> 当前分支：`codex/stategraph-checkpointer-rebuild`  
> 重建基点：`ef850ce6e8b71391203460f28670b1d85eb72c72`  
> 当前状态：按用户要求，在“强制分发与可信边界”阶段完成后暂停，等待其他 Agent 接手。

## 1. 本轮目标与不可变约束

原三层结构：

```text
StateGraph  ——提案——>  Control Kernel  ——授权——>  Orchestrator
（纯决策）              （唯一裁决与写入）           （唯一副作用）
```

目标结构：

```text
StateGraph + Checkpointer
        │
        ├─ Manager 需求分析：只提出动态路线和本轮人工审批节点
        ├─ 代码校验并冻结 route_hash / steps / approval_plan
        ├─ dispatch 节点：唯一 Agent 强制分发入口
        ├─ reconcile / Gate：唯一结果接收与状态推进入口
        ├─ human approval：独立人工 capability 写入
        └─ 最新 checkpoint：唯一可信状态源
```

必须继续遵守：

1. 不引入新的编排框架；只保留 LangGraph `StateGraph + checkpointer`。
2. Agent、日志和 launcher 都不是状态权威；只有最新 checkpoint 能推进工作流。
3. Manager 只能提出路线，不得指定 Agent、派发任务、审批或直接写状态。
4. Agent 到任务类型的映射由代码固定，Agent 无 runtime/human capability。
5. 每轮路线必须先人工确认；确认后路线和审批节点冻结，Agent 无权修改。
6. 单个 Agent 总执行预算为初次执行加两次自动重试；三次失败后进入人工审批。
7. 单次 Agent 尝试内，非法 JSON 使用同一 session 最多重新生成两次。
8. 所有 Agent 原始 stdout、stderr、进程结果和结构化原文必须保留。
9. 所有人工审批节点必须由代码生成、绑定当前 decision/route/candidate，不能由 Agent 自行通过。
10. monitor 与 UI 必须保持只读 checkpoint，并保留 SSE、自动续跑、会话与健康状态能力。

## 2. 为什么选择当前重建基点

选择 `ef850ce6e8b71391203460f28670b1d85eb72c72`，原因如下：

- 它是完整动态路由 StateGraph 大规模合入前的最后一个干净节点。
- 后续提交 `2db099d` 在多处 `.mjs` 和测试文件中引入混淆 JavaScript。
- `d0c4563` 虽首次加入 checkpointer，但已继承上述污染，不适合作为可信重建基点。
- 原工作分支 HEAD 为 `aca1889`；开始重建时工作区干净，污染来自提交历史，不是用户未提交改动。
- 已扫描确认当前基点不含已知污染模式。

安全注意：不要直接执行原 HEAD 中未重新审核的 `monitor/supervisor.mjs` 等旧实现。若要借鉴后续提交，只能逐文件静态审阅、重新测试，不能整段恢复旧三层框架。

## 3. 已完成内容

### 3.1 单一 StateGraph/checkpointer 核心

新增核心目录：`scripts/stategraph/`，主要文件如下：

- `state.mjs`：LangGraph 状态定义，包括路线、任务、审批、事件、候选 commit。
- `sqlite-checkpointer.mjs`：LangGraph checkpoint 的 SQLite 持久化实现。
- `database.mjs`：checkpoint 数据库连接和初始化。
- `events.mjs`：checkpoint 内哈希事件链。
- `policy.mjs`：动态路线的 Schema、顺序、阶段门槛和审批门槛校验。
- `graph.mjs`：唯一状态机；包含 initialize、decide、dispatch、reconcile、Gate、人工审批和完成节点。
- `runtime.mjs`：runtime/human capability、workflow lock、checkpoint 调用与恢复。
- `dispatcher.mjs`：固定 Agent 映射、持久 launcher、JSON 修复、结果接收。
- `agent-runner.mjs`：Agent 子进程、超时、stdout/stderr/raw log、Docker sandbox 收尾。
- `manager-context.mjs`：Manager 紧凑上下文和成本预算。
- `authority.mjs`：runtime 与 human 两种本地 capability；worker 环境移除这些 capability。
- `workflow-lock.mjs`：同 workflow 单写者锁。
- `process-utils.mjs`：跨平台进程启动与进程树终止。

CLI 新入口：`scripts/workflow.mjs`，支持：

```text
init
bootstrap
run
approve
snapshot
audit
manager-context
```

### 3.2 动态路线与审批冻结

新增：

- `config/stategraph-policy.json`
- `contracts/route-plan.schema.json`

代码支持的请求类别：

- `SMALL_CODE`
- `FEATURE`
- `TEST_ONLY`
- `ANALYSIS_ONLY`
- `RELEASE_ONLY`

已实现规则：

- Manager 输出 `route-plan.json`，但不能填写 Agent ID。
- `task_agents` 固定映射由代码注入。
- 每个被省略阶段必须有 `skipped_stages.reason`。
- `TEST_ONLY` 不允许经过 DEVELOPMENT 或 ARCHITECTURE。
- 有 DEVELOPMENT 必须有 TEST。
- 架构变更、数据迁移、公开 API、安全边界、多组件会强制 ARCHITECTURE。
- 高风险路线至少包含一个阶段后人工审批。
- 每轮始终先生成 `ROUTE_PLAN_CONFIRMATION`。
- 人工确认后冻结 `route_hash`、steps 和 approval plan；后续每轮重新计算哈希。
- 人工审批绑定 `decision_id`、`route_hash`，涉及代码候选时还绑定 `candidate_commit`。
- Agent 返回 `HUMAN_DECISION_REQUIRED` 时不能绕过 Gate：人工只能要求同一 Agent 携带决定重做，不能直接把未过 Gate 的结果标为完成。

### 3.3 自动重试和 JSON 恢复

已实现两层预算，二者不能混淆：

1. JSON 恢复：同一 Agent session、同一 run 内最多两次重新生成，只允许重写非法结构化文件。
2. Agent 执行：初次加两次自动重试，共三次；每次使用新的 run、session 和 worktree。

每次错误都会：

- 写入 checkpoint 的 `managerReports`。
- 追加哈希事件。
- 保留失败 run 的 worktree、artifact 和原始日志。
- 三次失败后生成 `ERROR_ESCALATION` 人工审批，只能选择同一 Agent 新批次重试或终止。

### 3.4 真实副作用与信任边界（本次暂停前刚完成）

新增：

- `scripts/stategraph/git-worktree.mjs`
- `scripts/stategraph/context-manifest.mjs`
- `scripts/stategraph/sandbox-runtime.mjs`
- `config/test-sandbox-policy.json`
- `deploy/sandbox/Dockerfile.test-node`

实现内容：

#### 隔离 Git worktree

- bootstrap 强制要求 `project_path_abs` 是现有 Git 仓库根。
- 初始 `HEAD` 作为 `baseCommit` 和首个 `candidateCommit` 写入 checkpoint。
- 每个 Agent 尝试使用：

```text
runtime/worktrees/<workflow>/<task>/<run>/repo
```

- 以 checkpoint 中的 `input_commit` 创建 detached worktree。
- retry 使用新 run 和新 worktree；失败工作区默认保留。
- DEVELOPMENT 和 TEST 的 `output_commit` 必须：
  - 是完整 40 位 commit SHA；
  - 在 worktree 中真实存在；
  - 是 `input_commit` 的后代；
  - 等于 worktree 当前 `HEAD`。
- TEST 没有修改代码时也必须用 `input_commit` 作为 `output_commit`，避免模糊状态。
- DEVELOPMENT/TEST 通过代码 Gate 后才推进 checkpoint 的 `candidateCommit`；若阶段还有人工审批，则人工批准后才推进。
- REVIEW/TEST/RELEASE 都从 checkpoint 当前 `candidateCommit` 创建任务，不能自行换候选版本。

#### 不可变上下文清单

- 每个 run 生成代码控制的 `context-manifest.json`。
- 清单包含 workflow/task/run/Agent、input commit、worktree、artifact、规则副本及其 SHA-256、预期输出路径。
- manifest SHA-256 写入 task checkpoint 和 launcher。
- dispatch 前、reconcile 前都会验证 manifest 和每个输入文件：存在、普通文件、非 symlink、SHA 一致。
- 规则副本和清单会尝试设为只读；Windows 上即使 chmod 不形成完整 ACL，reconcile 哈希检查仍 fail closed。
- Agent result 的 `artifact_manifest_hash` 必须等于 checkpoint 记录值。

#### 结果、证据和日志校验

- result 身份字段必须精确匹配 workflow/task/run/Agent/attempt/worktree/artifact/input commit。
- report、CommandRecord、evidence 引用必须：
  - 位于获授权的 worktree 或本 run artifact；
  - 文件真实存在；
  - 是普通非 symlink 文件。
- 接收代码计算并写入所有引用文件 SHA-256。
- CommandRecord 逐行做 Schema 与身份校验；stdout/stderr 必须存在，声明 SHA 时必须一致。
- Evidence 逐行做 Schema 校验；有 `locator_abs + sha256` 时会重新计算。
- 原始 JSON 在清洗前完整写入 `logs/agent-output.jsonl`，包括原文、原文 SHA 和清洗变换。
- 进程 stdout、stderr、dispatch 和 process result 写入 `logs/agent-process.jsonl`。

#### TEST 强制 Docker sandbox

- test-agent package 设为 `sandbox.mode=all`、`backend=docker`、`scope=session`、`workspaceAccess=none`。
- `tools.exec.host=sandbox`，`tools.elevated.enabled=false`。
- Docker 基线：network none、只读 rootfs、drop ALL capabilities、PID 256、2GiB、2 CPU、非 root 用户。
- 每个 test run 动态绑定：
  - `/worktree` rw
  - `/input` ro
  - `/agent-raw` rw
  - `/raw-logs` rw
- 代码检查 OpenClaw effective sandbox 配置、sandbox explain、sandbox list 和 `docker inspect`。
- attestation 必须证明容器 ID、image digest、mount、network、rootfs、capabilities 和资源限制。
- process attestation 与 Agent result 中的 attestation 必须完全一致；Agent 不能自报一个不同对象。
- 全局 OpenClaw sandbox bind 修改使用独占 lease，避免并行 test workflow 互相覆盖；忙时任务延后，不消耗 Agent 重试次数。
- runner 完成后验证 runtime、恢复原 bind 配置并释放 lease；失败则任务 fail closed。

### 3.5 Manager 成本优化检查

当前实现：

- `context_window_tokens = 1,000,000`
- `max_output_tokens = 32,000`
- 软预算为实际上下文窗口的 60%，即 600,000 tokens。
- 实际 Manager prompt 另设 12,000 字符硬上限。
- 默认只带最近 8 个事件和最近 4 个错误报告。
- 超长时继续压缩到最近 2 个事件、1 个错误报告和截断后的用户需求。
- Manager 不轮询运行中的 Agent；monitor/continuation 负责续跑。

已修复的成本问题：

- 不再把完整 checkpoint、全部历史事件、全部 Agent 原文反复发送给 Manager。
- 不再由 Manager 轮询长任务。
- 错误报告只传紧凑摘要，原始日志保留在 artifact。

下一位 Agent 仍需检查：安装器中的每 Agent 模型目录、context window 和 max output 是否与 `.env`/OpenClaw effective config 一致；当前分支尚未把后续分支中的模型目录同步逻辑完整迁入。

### 3.6 Monitor 与 UI

已将 monitor 改为只读最新 StateGraph checkpoints：

- `monitor/server.mjs`
- `monitor/config.mjs`
- `monitor/session-tailer.mjs`
- `monitor/artifact-watcher.mjs`
- `monitor/health-classifier.mjs`
- `monitor/workflow-continuation.mjs`
- `monitor/session-catalog.mjs`

保留能力：

- loopback + GET-only
- SSE
- checkpoint audit
- 自动续跑
- session 对话
- artifact 观察
- 健康分类
- telemetry
- Agent 列表

UI 标识改为 `STATEGRAPH CHECKPOINT / LOCAL OBSERVATORY`。

滚动修复：

- conversation console、stage 使用 `overflow:hidden` 和 `min-height:0`。
- conversation history 独立纵向滚动。
- Agent rail 独立滚动。
- 使用 `overscroll-behavior:contain` 和 `scrollbar-gutter:stable`。
- 390px 窄屏使用两行 grid，不与 Live Feed 重叠。
- CSP 允许 `http://127.0.0.1:*`，支持自定义 loopback monitor 端口。

此前真实浏览器验证：

- 1920×1080：conversation `scrollHeight=6310`、`clientHeight=660`。
- 滚动对话时页面 `scrollY` 不变化。
- conversation 底部与 Live Feed 顶部间隔 28px，`overlapsFeed=false`。
- 390×844：`overlap=false`。

### 3.7 Manager 永久规则

已重写：

- `agents/manager-agent/workspace/AGENTS.md`
- `agents/manager-agent/workspace/TOOLS.md`
- `agents/manager-agent/workspace/IDENTITY.md`

新规则明确：Manager 只提出路线，不派发、不写状态、不审批、不调用旧 Orchestrator/Control Kernel、不使用 session 工具、不轮询。

Agent package 层已开始收紧：所有内置 worker 的 `callable_by_manager=false`，Manager delegation 改为 `off + allowAgents=[]`；安装器已开始同步完整 sandbox/tools 配置。对应旧测试和文档尚未全部迁移，见后续计划。

## 4. 自研功能清单与实现方式

以下是没有引入新框架、在 LangGraph/Node 标准库/Ajv 之上实现的项目内功能：

| 自研功能 | 实现方式 |
|---|---|
| SQLite checkpointer | 实现 LangGraph `BaseCheckpointSaver` 接口，把 checkpoint、pending writes 和 metadata 存入 SQLite |
| checkpoint 哈希事件链 | canonical JSON + SHA-256，事件记录前序哈希，audit 从 checkpoint 重放验证 |
| 双 capability | runtime 与 human token 分文件生成；timing-safe compare；worker 环境剥离 token |
| workflow 单写锁 | 原子 `wx` lock 文件 + stale 检查，避免同 workflow 并发写 checkpoint |
| 固定强制分发 | task kind → Agent ID 代码映射；dispatch 节点唯一调用 OpenClaw Agent CLI |
| 动态路线编译器 | route-plan Schema + 生命周期顺序、request class、risk flag、跳过原因和审批门槛 |
| 路线冻结 | canonical route body 计算 route_hash；人工确认后保存 frozen metadata；每轮重新校验 |
| Agent/JSON 双重重试 | task attempt 和 same-session JSON regeneration 两个独立计数器 |
| 原始输出账本 | stdout/stderr/process/result/raw JSON 追加 JSONL；最终发布文件由本地代码原子写入 |
| Git worktree 管理 | 每 run detached worktree；HEAD、commit 类型和 merge-base ancestry 校验 |
| 不可变上下文清单 | 规则/任务输入复制、SHA manifest、只读标志、dispatch/reconcile 双重校验 |
| 证据接收边界 | 路径归属、普通文件、非 symlink、Schema、身份和 SHA 校验 |
| Docker sandbox attestation | OpenClaw effective config + sandbox explain/list + docker inspect 多源交叉验证 |
| sandbox 全局 lease | 动态 bind 配置使用独占租约；结束恢复配置；并发忙时延后而非消耗 Agent attempt |
| Manager 紧凑上下文 | 字符上限、事件/错误窗口、二次压缩和软 token 预算 |
| monitor checkpoint read model | 直接读取 LangGraph checkpoint 数据库，不依赖旧控制状态表 |

## 5. 已完成验证

### StateGraph 测试

命令：

```text
node --test tests/stategraph-*.test.mjs
```

结果：`14 passed, 0 failed`。

覆盖：

- 动态路线和固定 Agent 映射。
- TEST_ONLY 路由门槛。
- 架构与高风险审批门槛。
- checkpoint 恢复、人工冻结与事件链。
- Agent 三次尝试后人工升级。
- 同 session JSON 最多两次重新生成。
- 每 run 独立 worktree、commit ancestry、失败 worktree 保留。
- context manifest 输入篡改检测。
- Docker policy、mount plan、attestation、配置准备与恢复。

### Monitor 测试

此前已完成 monitor 相关 12 项测试，全部通过；包含 HTTP、SSE、tailer、artifact watcher、session catalog 和静态 dashboard。

### Runtime bundle / 安装验证

- `tests/runtime-bundle.test.mjs`：3 项通过。
- 两个 validate-install 平台包装测试第一次运行失败，唯一原因是 `templates/result.json` 的 `artifact_manifest_hash` 仍为 null。
- 模板随后已改为合法 64 位 SHA 占位值，Runtime Guard 自检恢复通过：

```text
node scripts/runtime-guard.mjs self-check --project-root <当前项目绝对路径>
```

结果：`ok=true, contracts=36, templates=10`。

- 随后已完整重跑 `tests/validate-install.test.mjs`：`4 passed, 0 failed`，Bash 与 PowerShell dry-run 隔离验证均通过。

### 真实环境检查

- OpenClaw 当前 effective test-agent 配置可读到 `mode=all`、`backend=docker`、`workspaceAccess=none`、`exec.host=sandbox`、`elevated=false`。
- Docker CLI 已安装：28.5.1。
- Docker Desktop Linux daemon 当前未启动，连接 named pipe 失败；因此真实容器创建、image inspect 和完整 test-agent E2E 尚未验证。
- 不得把 mock sandbox 单测描述成真实 Docker E2E 已通过。

## 6. 可以复用与必须重做的边界

### 可以复用

- 现有 Agent 角色和 workspace 目录结构。
- LangGraph StateGraph 概念与当前新 checkpointer 实现。
- `scripts/runtime-core/json-ingestion.mjs` 的 JSON 清洗。
- `scripts/runtime-core/atomic-store.mjs` 的原子写入。
- 通用 JSON Schema 中仍与新状态边界一致的部分。
- monitor telemetry、redactor、event hub、session parsing。
- Agent package 安装与组件管理的目录/保护机制。

### 必须继续重做或清理

- 所有 worker Agent 的永久规则仍大量引用 Control Kernel、local-orchestrator、Manager 派发和 Runtime Guard 自决。
- 旧 Control Kernel/Orchestrator 代码、配置、测试尚未删除。
- package.json 仍以旧 `test:control-kernel` 为主入口，尚未切换完整 StateGraph 测试集。
- README、architecture、manager orchestration、human approval、monitor、JSON recovery 等总文档尚未迁移。
- 安装器和验证器中的“Manager 可调用 worker”旧断言尚未全部更新。
- TEST Agent workspace 文字仍声明 `UNSANDBOXED_LOCAL`，必须改为强制 Docker；当前只有 package/config/runtime 代码已改。
- 旧 supervision/wake-outbox 是否完全删除尚未最终裁定；只保留 monitor continuation 真正需要的部分。

## 7. 下一位 Agent 的建议执行顺序

### 阶段 A：统一所有 worker 永久规则

必须更新：

- `agents/common/*.md`
- architect/developer/requirement/review/test/release 的 `AGENTS.md`、`TOOLS.md`、`IDENTITY.md`、必要的 `SOUL.md`
- 各 workspace `rules/README.md`

统一规则：

- StateGraph dispatch 是唯一派发入口。
- 最新 checkpoint 是唯一事实源。
- Agent 不持有 runtime/human capability。
- Agent 不调用其他 Agent、不修改路线、不审批、不推进状态。
- Agent 只写本 run 的 `.agent-raw`、获准 worktree 和 raw logs。
- 本地代码负责清洗、Ajv、最多两次 JSON 重生成和最多三次 Agent attempt。
- 所有 stdout/stderr/raw JSON 由 runner/ingestion 记录。
- test-agent 必须使用 `SANDBOXED_DOCKER`；删除所有“本阶段无 sandbox”文字。

### 阶段 B：删除旧三层框架

计划删除或替换：

- `scripts/control-kernel.mjs`
- `scripts/control-core/**`
- `scripts/orchestrator.mjs`
- `scripts/orchestrator/**`
- `scripts/workflow-runner.mjs`
- 旧 Control Kernel/Orchestrator 状态机配置。
- 只为旧三层架构存在的 tests。

删除前逐项确认新 StateGraph 已覆盖对应功能，不得先删证据后补功能。

### 阶段 C：包入口、安装与模型成本

- package.json 新增 `test:stategraph` 和新的总测试顺序。
- 移除 `test:control-kernel`。
- 把 `@langchain/langgraph-checkpoint@1.1.3` 从传递依赖改为同框架显式依赖。
- 更新 package-lock，不新增其他框架。
- 修改 install/validate 测试：Manager `delegationMode=off`、allowAgents 空；worker callable false。
- 完整迁移每 Agent 模型目录、context window、max output 和 token field 同步逻辑。
- 检查 Manager 的 1M/32k/60% 配置是否与实际模型一致；不一致则 fail closed 或明确降级，不允许只在 policy 文档里声称。
- 增加 raw log 目录 ACL 安装检查；Windows 使用真实 ACL 验证，不能只依赖 chmod。

### 阶段 D：完善测试覆盖

- 增加 DEVELOPMENT → candidate commit → TEST/REVIEW/RELEASE 绑定的完整 checkpoint 测试。
- 增加 TEST 修改测试代码后推进 candidate commit 的测试。
- 增加非法 output commit、非 descendant、worktree HEAD 不匹配测试。
- 增加 report/evidence/CommandRecord 缺失、symlink、SHA 不匹配测试。
- 增加 sandbox 全局 lease 并发与 stale 恢复测试。
- Docker daemon 启动后构建 `openclaw-test-node:22-slim`，运行真实 test-agent E2E。
- 验证 Agent runner 异常退出后 sandbox bind、容器和全局 lease 均恢复。
- 完整重跑 monitor 及浏览器窄屏/宽屏验证。

### 阶段 E：文档迁移

必须更新：

- `README.md`
- `docs/architecture.md`
- `docs/manager-orchestration.md`
- `docs/human-approval.md`
- `docs/monitoring.md`
- `docs/llm-json-recovery.md`
- `docs/current-progress-assessment.md`
- `CHANGELOG.md`

文档应包含：基点选择、污染规避、复用/重做矩阵、完整流程图、动态审批示例、成本优化、自研功能、部署与恢复方式。

### 阶段 F：最终验证与提交

建议依次执行：

```text
node --test tests/stategraph-*.test.mjs
node --test --test-concurrency=1 tests/monitor-*.test.mjs
node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
npm test
git diff --check
git status --short
```

随后：

- 扫描已知混淆/污染模式。
- 审核是否仍有生产代码引用 Control Kernel/Orchestrator。
- 审核所有 Agent 规则中的旧术语。
- 只在用户确认后 commit/push/PR；当前没有 commit、push 或 PR。

## 8. 当前已知风险和注意事项

1. 当前工作区是大规模未提交改动；不要 reset、checkout 或覆盖用户/前序 Agent 改动。
2. Docker daemon 未运行，真实 sandbox E2E 未完成。
3. 全局 sandbox bind 依赖 OpenClaw 配置临时修改，已有独占 lease，但仍需异常崩溃恢复测试。
4. 安装器对 sandbox_config/tools_config 的同步已开始修改，尚未完成全量跨平台验证。
5. worker 规则尚未同步，真实 Agent 执行前必须先完成阶段 A，否则 prompt 可能仍含旧框架指令。
6. 旧框架代码仍在仓库中；在清理完成前不要把当前分支描述成“已经完全删除三层架构”。
7. `package.json` 仍是旧测试入口；不能仅以 `npm test` 当前结果评价新核心。
8. monitor 已改读 checkpoint，但旧 supervisor/wake 模块是否保留需要在删除阶段做引用审计。
9. 当前 package 层已禁止 Manager delegation，但用户机器的 OpenClaw effective config 仍可能是旧 allowlist；必须通过更新后的 installer 正式同步后再验收。

## 9. 暂停点

本文件写入后，本 Agent 按用户要求暂停。下一位 Agent 应从“阶段 A：统一所有 worker 永久规则”继续，不要重新实现已经通过 14 项测试的 StateGraph、worktree、context manifest 和 sandbox 核心，除非新测试证明存在缺陷。
