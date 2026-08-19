# openclaw-multi-agent

## 当前交互模式（重要）

本项目现在有三个入口，职责不同：

| 入口 | 是否依赖 OpenClaw | 用途 |
| --- | --- | --- |
| OpenClaw Gateway / Manager CLI | 是 | 解析用户需求、生成并确认 route plan、执行 Agent workflow。当前 Agent 默认仍由 OpenClaw CLI 启动。 |
| 本地 Node Monitor | 否（但运行 workflow 时仍需要可用的 StateGraph runtime） | 查看 checkpoint、任务、事件审计和历史；显式开启交互后，也可新建、推进和审批 workflow。 |
| `scripts/workflow.mjs` | 否 | CLI 后备入口，用于初始化 capability、bootstrap、run、approve、snapshot 和 audit。 |

因此，当前不是“完全脱离 OpenClaw”。P2 原生 Agent Executor 只完成了可替换边界，默认执行路径仍是 OpenClaw；不要删除或停用 OpenClaw Gateway，除非你已明确切换并验证 native executor。

Monitor 的对话框目前使用本地规则型 `ChatProvider` 生成 `intent_draft`，它不会绕过人工确认，也不会直接执行 runtime 写操作。需要 Manager 真正分析需求并生成完整 route plan 时，使用 OpenClaw Manager CLI 或 `scripts/workflow.mjs` 的结构化流程。

## 启动与使用

### 1. 初始化 capability

首次使用或 capability 文件丢失时执行一次：

```powershell
node scripts/workflow.mjs init --project-root .
```

该命令生成：

```text
runtime/stategraph/runtime.capability
runtime/stategraph/human-approval.capability
```

不要把这两个文件内容复制到浏览器或提交到 Git。

### 2. 使用 OpenClaw Manager CLI（完整交互路径）

先确保 OpenClaw Gateway 可用，并安装项目的兼容插件：

```powershell
openclaw plugins install --link extensions/stategraph-webchat
openclaw config set plugins.entries.stategraph-webchat.enabled true --strict-json
openclaw config set plugins.entries.stategraph-webchat.hooks.allowConversationAccess true --strict-json
openclaw config set plugins.entries.stategraph-webchat.config.projectRoot '"D:/MicroConnect/project/openclaw-multi-agent"' --strict-json
openclaw gateway restart
openclaw gateway status
```

在 Manager 对话中，先确认完整步骤；只有用户明确确认后，Manager 才会提交 `CREATE`、`CHANGE` 或 `DECISION` 请求。StateGraph 随后负责 route 冻结、Agent 派发、产物校验、重试和审批等待。

### 3. 启动本地 Monitor

Monitor 默认只读，这是设计上的安全默认值。启动只读面板：

```powershell
npm run monitor:start
```

然后打开：

```text
http://127.0.0.1:4319/
```

要启用截图中“生成意图草案”、推进、连续推进、审计等交互控件，必须在启动 Monitor 前显式开启：

```powershell
$env:MONITOR_INTERACTIVE = "true"
$env:MONITOR_CONTINUATION = "false"
npm run monitor:start
```

Linux/macOS：

```bash
MONITOR_INTERACTIVE=true MONITOR_CONTINUATION=false npm run monitor:start
```

也可以在 `config/monitoring.example.json` 对应配置中设置：

```json
{
  "interactive_controls_enabled": true,
  "workflow_continuation_enabled": false,
  "control_token_header": "x-stategraph-control"
}
```

交互模式仍要求 Monitor 进程能读取 capability 文件，并且只接受 loopback 请求和合法 Origin。若 capability 缺失，服务会自动降级为只读，不会崩溃。

### 4. 使用 CLI 后备入口

```powershell
node scripts/workflow.mjs bootstrap --project-root . --workflow-id WF-example --request-file request.json
node scripts/workflow.mjs run --project-root . --workflow-id WF-example
node scripts/workflow.mjs snapshot --project-root . --workflow-id WF-example
node scripts/workflow.mjs audit --project-root . --workflow-id WF-example
```

遇到 `WAITING_HUMAN` 时，根据返回的 `decision_id` 执行：

```powershell
node scripts/workflow.mjs approve --project-root . --workflow-id WF-example `
  --decision-id DEC-example --choice APPROVE --decided-by human:operator
```

## 常见现象排查

### 页面显示“只读监测已连接”

这表示 `interactive_controls_enabled` 没有开启，或 capability 文件不可读。它不是 workflow 生成失败。检查：

```powershell
Test-Path runtime/stategraph/runtime.capability
Test-Path runtime/stategraph/human-approval.capability
```

然后重新启动 Monitor，并确认 `MONITOR_INTERACTIVE=true` 是在启动前设置的。

### 4319 端口无法访问

说明 Monitor 进程没有运行，或端口被其他进程占用。项目不会自动启动 Monitor：

```powershell
npm run monitor:start
```

如果端口已被占用，可临时改用：

```powershell
$env:MONITOR_PORT = "4320"
npm run monitor:start
```

### Monitor 有 workflow，但推进按钮不可用

只读模式下按钮必然禁用。启用交互模式后仍不可用时，检查 capability、Origin 和 Monitor 日志；不要把 capability 令牌放进前端代码。

### Monitor 对话能生成草案，但不能创建 workflow

这是当前实现的预期行为：`CREATE` 必须包含经过人工确认的完整 `route_plan`。本地规则型 ChatProvider 只负责意图草案，不负责替代 Manager 的路线分析。请在 OpenClaw Manager CLI 中完成 route plan 确认，或使用 `bootstrapConfirmed`/结构化 CLI 流程。

### 没有 PostgreSQL 时 workflow 无法作为正式运行

正式运行使用 PostgreSQL：`kernel` 保存 Control Kernel 事实，`langgraph` 保存 LangGraph checkpoint。带 `--db` 的内存 checkpointer 主要用于离线测试，不应作为长期运行数据库。先配置 `.env` 中的 `OPENCLAW_PG_URL`，再执行：

```powershell
npm run kernel:schema
npm run kernel:status
```

### Agent 没有执行

当前默认 executor 仍是 OpenClaw。检查：

```powershell
openclaw --version
openclaw gateway status
```

Native executor 目前只是可替换边界，尚未替换所有 Agent kind；不要因为 Monitor 页面可打开就认为 Agent 已脱离 OpenClaw。

本项目使用 LangGraph `StateGraph + checkpointer` 驱动本机多 Agent 软件交付流程。最新 checkpoint 是 workflow、路线、任务、审批、候选 commit 和事件链的唯一事实源；Manager、worker、launcher、日志和 monitor 都不能直接推进状态。

## 核心边界

```text
用户在 CLI 向 Manager 提出请求
  -> Manager 展示完整 route-plan 并等待用户确认
  -> 用户确认后 Manager 写持久化请求，StateGraph 校验并冻结 route_hash / steps / approval_plan
  -> StateGraph dispatch 按 task kind 固定选择 Agent
  -> Agent 在独立 worktree 执行并只写 .agent-raw / raw logs
  -> 本地 ingestion + Gate 校验结果、证据、commit 和 sandbox
  -> checkpointer 原子推进 candidate 与下一节点
```

- 不存在第二套 workflow 状态库或 Agent 可写状态文件。
- Manager 不指定 Agent、不派发、不审批、不轮询运行中的 worker。
- worker 不持有 runtime/human capability，也不能调用其他 Agent。
- 每个 Agent task 最多执行 3 次；失败后进入绑定当前任务的人工审批。
- 同一 session 的非法 JSON 最多重新生成 2 次，只允许重写结构化输出。
- DEVELOPMENT 和 TEST 必须提交真实 Git commit；TEST 可修改测试代码并推进 candidate。
- TEST 强制使用 `SANDBOXED_DOCKER`，禁止主机执行、网络、提权和额外 mount。
- monitor 是 GET-only 的 Node.js 本机工作台：只观测 checkpoint 与 telemetry，不持有审批或续跑能力。

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 环境要求

- Node.js 22.5+、npm、Git。
- OpenClaw CLI 可用。
- Windows 使用 PowerShell 7；Bash 安装器还需要 `jq`。
- 执行 TEST 前需要 Docker Desktop/Linux Docker daemon，并构建 `openclaw-test-node:22-slim`。

```powershell
npm install
openclaw --version
node --version
git --version
```

模型默认限制为：

- context window：`200000`
- max output：`32000`
- Manager soft input budget：`120000` tokens（60%）
- 单次紧凑 Manager prompt：`12000` 字符

安装器会把这些限制同步到 OpenClaw provider/model 目录；模型行缺失或同一模型限制不一致时失败关闭。

## 安装 Agent

先执行 dry-run；dry-run 不修改 OpenClaw 配置或 artifact ACL。

```powershell
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1
```

```bash
bash scripts/install.sh --runtime-root runtime
bash scripts/install.sh --apply --yes --runtime-root runtime
bash scripts/validate-install.sh
```

可用 `-ModelConfig` / `--model-config` 指向 `config/agent-models.example.json`。安装 Apply 会将 `runtime/artifacts` 设置为 Windows 受保护 DACL，或 Unix `0700`。

### 更新已安装 Agent

修改以下任一内容后，都需要同步已安装 Agent，才能让 `runtime/agents/*/workspace` 中的副本、OpenClaw Agent 配置和 runtime bundle 与源码一致：

- `agents/<agent-id>/workspace/` 中的角色说明、工具规则或身份说明；
- `agents/common/` 中的通用规则；
- `agents/packages/builtin/*.json` 中的 Agent、模型、sandbox 或工具配置；
- 安装脚本、模板或会被安装流程复制到 Agent workspace 的内容。

先运行 dry-run，再执行 Apply：

**Windows（PowerShell；可用 `-AgentIds` 只同步指定 Agent）**

```powershell
# 全部项目 Agent：先预览，再同步
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime

# 只同步指定 Agent（逗号分隔）
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime `
  -AgentIds developer-agent,test-agent

# 同步后验证
pwsh -NoProfile -File scripts/validate-install.ps1
```

**Linux（Bash；当前 Bash 安装器会同步全部项目 Agent）**

```bash
# 全部项目 Agent：先预览，再同步
bash scripts/install.sh --runtime-root runtime
bash scripts/install.sh --apply --yes --runtime-root runtime

# 同步后验证
bash scripts/validate-install.sh
```

### 安全重装全部项目 Agent

仅在 Agent 注册状态、runtime workspace/state 损坏，或常规更新无法恢复一致性时使用。重装会备份配置和受管理 runtime，删除**经路径校验确认属于本项目**的已安装 Agent，再重新安装；它不会自行停止或启动 OpenClaw Gateway。

先手动停止 Gateway，再执行 dry-run 和 Apply：

**Windows（PowerShell）**

```powershell
# Gateway 已停止后：先预览
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime

# Gateway 已停止后：执行安全重装；-GatewayStopped 是必填确认
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped `
  -RuntimeRoot runtime
```

**Linux（Bash；完整安全重装目前使用跨平台 PowerShell 7 脚本）**

```bash
# 先确认 pwsh 可用，并手动停止 OpenClaw Gateway
pwsh --version

# Gateway 已停止后：先预览
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime

# Gateway 已停止后：执行安全重装
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped \
  -RuntimeRoot runtime
```

重装完成后再启动 Gateway，并执行对应平台的 `validate-install` 命令。若将来新增 Bash 重装脚本或修改这些参数，必须同步更新本节命令。

## 运行 Workflow

### Manager CLI 与 StateGraph Bridge

本项目通过 `stategraph-webchat` Gateway 插件提供后台 StateGraph bridge。插件不接管 Manager 的入站消息或回复；Manager 在 CLI 中直接与用户对话，并且仍不持有 runtime 或 human capability。插件只处理用户确认后写入持久队列的请求、推进 StateGraph，以及为结构化输出调用临时注入 JSON Schema。

**Windows（PowerShell）**

```powershell
openclaw plugins install --link extensions/stategraph-webchat
openclaw config set plugins.entries.stategraph-webchat.enabled true --strict-json
openclaw config set plugins.entries.stategraph-webchat.hooks.allowConversationAccess true --strict-json
openclaw config set plugins.entries.stategraph-webchat.config.projectRoot '"D:/MicroConnect/project/openclaw-multi-agent"' --strict-json
openclaw gateway restart
openclaw gateway status
```

**Linux（Bash；把路径替换为服务器上的项目绝对路径）**

```bash
openclaw plugins install --link extensions/stategraph-webchat
openclaw config set plugins.entries.stategraph-webchat.enabled true --strict-json
openclaw config set plugins.entries.stategraph-webchat.hooks.allowConversationAccess true --strict-json
openclaw config set plugins.entries.stategraph-webchat.config.projectRoot '"/absolute/path/openclaw-multi-agent"' --strict-json
openclaw gateway restart
openclaw gateway status
```

插件不再接管 Manager 的对话或合成回复。Manager 在 CLI 中直接与用户澄清并展示完整步骤；只有用户明确确认后，Manager 才向 workspace 的 `.stategraph/requests/` 写入 `CREATE`、`CHANGE` 或 `DECISION` 请求。插件后台校验请求并交给 StateGraph，处理回执和已清洗状态分别持久化到 `.stategraph/receipts/` 与 `.stategraph/status/`。冻结路线只能由用户提出、Manager 代为提交的 `CHANGE` 请求修改，已完成阶段由 StateGraph 强制保留。

初始化本地 runtime/human capability：

```powershell
node scripts/workflow.mjs init --project-root .
```

请求文件示例：

**Windows（PowerShell）**

```json
{
  "text": "实现功能并完成评审、测试和发布准备",
  "project_path_abs": "D:/absolute/path/to/target-repository"
}
```

**Linux（Bash）**

```json
{
  "text": "实现功能并完成评审、测试和发布准备",
  "project_path_abs": "/absolute/path/to/target-repository"
}
```

创建并推进 workflow：

**Windows（PowerShell）**

```powershell
node scripts/workflow.mjs bootstrap --project-root . --workflow-id WF-example --request-file request.json
node scripts/workflow.mjs run --project-root . --workflow-id WF-example
node scripts/workflow.mjs snapshot --project-root . --workflow-id WF-example
node scripts/workflow.mjs audit --project-root . --workflow-id WF-example
```

**Linux（Bash）**

```bash
node scripts/workflow.mjs bootstrap --project-root . --workflow-id WF-example --request-file request.json
node scripts/workflow.mjs run --project-root . --workflow-id WF-example
node scripts/workflow.mjs snapshot --project-root . --workflow-id WF-example
node scripts/workflow.mjs audit --project-root . --workflow-id WF-example
```

每次 `run` 只执行一个有界 StateGraph 动作。遇到 `WAITING_HUMAN` 时，用返回的 `decision_id` 和允许选项审批：

```powershell
node scripts/workflow.mjs approve --project-root . --workflow-id WF-example `
  --decision-id DEC-example --choice APPROVE --decided-by human:operator
```

**Linux（Bash；续行符为反斜杠，不能使用 PowerShell 反引号）**

```bash
node scripts/workflow.mjs approve --project-root . --workflow-id WF-example \
  --decision-id DEC-example --choice APPROVE --decided-by human:operator
```

路线确认后，代码会在每轮推进前重新验证冻结的 `route_hash`。任何路线、candidate、manifest、证据或事件链漂移都会停止流程。

## Agent 角色

| Agent | 固定职责 |
| --- | --- |
| `manager-agent` | 分析请求并提出动态路线；不派发、不审批、不写状态 |
| `requirement-agent` | 范围、边界与验收条件 |
| `architect-agent` | 架构、设计、接口、风险与测试策略 |
| `developer-agent` | 在授权 worktree 实现并提交候选 commit |
| `review-agent` | 审查 checkpoint 当前 candidate |
| `test-agent` | 在 Docker sandbox 中执行/补充测试并提交测试 commit |
| `release-agent` | 校验 candidate、回滚信息和发布准备；不执行部署 |

## PostgreSQL 前置准备

StateGraph、Control Kernel 与 LangGraph Checkpointer 共用一个 PostgreSQL 实例、两个 schema：`kernel` 存 run/task/execution/artifact/event 事实，`langgraph` 存 checkpoint 决策投影。Monitor telemetry 仍用独立 SQLite，不迁 PG。

启动 workflow 或 Monitor 前先准备数据库：

```bash
# 1. 起一个本地 PG（示例）
docker run -d --name openclaw-pg \
  -e POSTGRES_USER=openclaw -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=openclaw -p 5432:5432 postgres:16
```

```text
# 2. 复制 .env.example 为 .env，至少配置连接串（.env 不进仓库）
OPENCLAW_PG_URL=postgresql://user:password@localhost:5432/openclaw
OPENCLAW_KERNEL_SCHEMA=kernel
```

```powershell
# 3. 幂等应用 kernel schema DDL（langgraph 表由 checkpointer setup() 自建）
npm run kernel:schema

# 4. 查看 run/task/execution 计数与过期租约
npm run kernel:status

# 5. kernel 测试必须是真 PASS，不能是 SKIP
npm run test:kernel
```

未配置 `OPENCLAW_PG_URL` 时 `test:kernel` 整套 SKIP，PG 侧代码不会被执行——务必确认输出中是正数 `# pass` 而不是 SKIP。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENCLAW_PG_URL` | 无（必填） | PostgreSQL 连接串，含口令，只写入本机 `.env` |
| `OPENCLAW_PG_POOL_MAX` | `8` | 连接池上限 |
| `OPENCLAW_PG_STATEMENT_TIMEOUT_MS` | `15000` | 单条语句超时 |
| `OPENCLAW_PG_CONNECT_TIMEOUT_MS` | `5000` | 建连超时 |
| `OPENCLAW_KERNEL_SCHEMA` | `kernel` | Kernel schema 名，连接建立时写入 `search_path` |
| `OPENCLAW_KERNEL_LEASE_SECONDS` | `120` | 租约兜底默认值；`config/stategraph-policy.json` 的 `lease_seconds` 优先 |
| `OPENCLAW_WORKER_ID` | `worker-<pid>` | 本进程 worker 标识，写入 `kernel.executions.worker_id` |

租约与心跳的实际生效值来自 `config/stategraph-policy.json` 的 `lease_seconds` / `heartbeat_interval_seconds`，并强制满足 `lease_seconds > heartbeat_interval_seconds * 2`，否则加载即抛 `POLICY_LEASE_TOO_SHORT`。

数据库凭据处置要求见 [SECURITY.md](SECURITY.md) §5.1。

## Node Monitor

> Note: this section supersedes the older read-only wording above. Monitor is read-only by default, but supports local write controls when `MONITOR_INTERACTIVE=true` and capability files are available. It never replaces OpenClaw's Agent executor.

```powershell
npm run monitor:start
# 或
```

```bash
MONITOR_PORT=4319 npm run monitor:start
```

启动后打开 `http://127.0.0.1:4319/`；面板、API 和 SSE 使用同一个 Node 服务，无需手工打开 `index.html`。界面保留深浅主题和现有工作台风格，但不包含任何确认、重做、停止、重试或路线修改控件；所有交互都在 Manager CLI 中完成。前端只维持一个全局 SSE，并仅在 checkpoint read model 变化时更新，不再每三秒重载页面或重建连接。部署说明见 [docs/monitoring.md](docs/monitoring.md)。项目不包含 Java、Servlet 或 Tomcat monitor 代理。

## 运行目录

```text
runtime/
  stategraph/runtime.capability
  stategraph/human-approval.capability
  stategraph/test-sandbox-global.lock
  artifacts/cas/<sha-prefix>/<sha256>
  artifacts/<workflow>/<task>/runs/<run>/
    .agent-raw/
    .stategraph-ingest/
    logs/
    output/
  worktrees/<workflow>/<task>/<run>/repo/
```

原始 stdout、stderr、进程结果、Agent 原文和清洗变换会保留；最终发布文件由本地代码原子写入。

## 测试

```powershell
npm test
```

**Linux（Bash；`npm test` 命令相同）**

```bash
npm test
```

也可分组执行：

```powershell
node --test tests/stategraph-*.test.mjs
node --test --test-concurrency=1 tests/monitor-*.test.mjs
node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
```

**Linux（Bash；shell 会展开 `*` 通配符）**

```bash
node --test tests/stategraph-*.test.mjs
node --test --test-concurrency=1 tests/monitor-*.test.mjs
node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
```

当前自动化测试覆盖 checkpoint 恢复、路线冻结、候选 commit、证据 SHA、JSON 恢复、sandbox lease 和 monitor。Docker daemon 未运行时，mock command-boundary 测试仍可执行，但不能视为真实容器 E2E。
