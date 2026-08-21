# openclaw-multi-agent

`openclaw-multi-agent` 是一个由路线驱动的 OpenClaw 工作流系统。Manager 在 OpenClaw 原生对话中确认用户意图，Node Orchestrator 按确认后的路线串行调度需要的 Agent，PostgreSQL Control Kernel 保存工作流事实，Monitor 提供本地只读运维视图。

## 整体架构

```text
用户 <-> OpenClaw Manager 对话
               |
               v
       .orchestrator/requests/*.json
               |
               v
        Node Orchestrator
      /          |          \\
    调度     Manager 通知    HR 任务
    |             |             |
    v             v             v
 OpenClaw       Manager       HR Agent
 业务 Agent      会话          会话
    \\             |             /
     \\------------v------------/
       PostgreSQL Control Kernel
 runs / tasks / executions / artifacts /
 approvals / notifications / events / hr_jobs
               |
               v
 本地只读 Monitor + SSE + OpenClaw 会话读取器
```

| 组件 | 功能 |
| --- | --- |
| OpenClaw | 承载 Manager、六个业务 Worker 和后台 HR Agent 的会话。 |
| Node Orchestrator | 唯一调度者。冻结确认后的路线，创建串行任务，运行 Worker，摄取输出，处理重试和审批边界，并向 Manager 投递进度通知。 |
| PostgreSQL Control Kernel | 唯一的 workflow/task/execution/approval 事实源，同时保存通知 outbox、HR 任务、artifacts 以及追加式哈希链事件。 |
| Monitor | 仅用于观察的本地运维界面。读取 Kernel 和脱敏后的 OpenClaw 会话，提供 REST/SSE；不能创建、推进、审批、取消或重做工作流。 |
| SQLite telemetry | Monitor 的本地临时缓存，用于会话游标、脱敏活动、健康快照和 SSE 遥测；不会把工作流事实写回 PostgreSQL。 |

当前运行时不再使用 LangGraph/StateGraph、checkpoint 存储或 webchat 插件。

更新旧安装时，`install.ps1` 和 `install.sh` 会先备份配置，仅自动删除已经废弃的 `stategraph-webchat` 插件路径和注册项，然后同步 Agent。其他无效的 OpenClaw 配置不会被猜测性修改，仍会作为明确的安装错误报告。如果旧插件导致 `config file` 命令本身失败，两个安装脚本会从诊断信息中定位本地配置文件，仅用于执行这一次迁移。

## 状态模型

```text
Workflow: ACTIVE -> WAITING_HUMAN | HOLD | TERMINAL
TERMINAL: SUCCEEDED | FAILED | CANCELLED

Task: READY -> RUNNING -> SUCCEEDED | FAILED | WAITING_HUMAN | CANCELLED

Execution 内部状态: LEASED | RUNNING | SUCCEEDED | FAILED | LEASE_EXPIRED | CANCELLED
```

`executions` 的租约只用于 heartbeat、超时回收和单任务互斥，不是第二套业务状态机。迁移时，如果旧任务状态无法在不猜测的情况下恢复，则将任务置为 `FAILED`，并把尚未终止的工作流置为 `HOLD`，等待人工检查。

## Manager 与人工审批

Manager 是唯一的用户交互控制点：

1. 理解请求并生成 `route_plan`，只包含实际需要的阶段，同时记录跳过阶段的原因、自动流转点和人工审核点。
2. 在 OpenClaw 原生对话中展示路线，等待用户明确确认。
3. 只有确认后，才写入绑定会话的 `CREATE` 请求。
4. 任务需要审核、失败、要求重做、恢复或结束时，Orchestrator 先写 Kernel 事件和持久化通知，再要求 Manager 在原始会话中向用户转达。
5. Manager 收集用户文字决定并写入绑定会话的 `DECISION` 请求；Manager 不代替用户决定，也不直接调度任务或修改数据库。

每个 Manager 请求都必须包含 `manager_session_id`、`manager_session_key` 和明确的 `user_authorized` 证据。`CREATE` 与 `CHANGE` 请求会冻结完整路线；`DECISION` 必须引用待处理审批和原始会话。

## 路线与 Agent

路线不要求每次执行完整流水线。Manager 可以选择任意合法的有序子集，并为每个省略阶段记录原因：

```text
REQUIREMENTS -> ARCHITECTURE -> DESIGN -> DEVELOPMENT -> TEST -> CODE_REVIEW -> RELEASE
```

`DEVELOPMENT` 必须包含 `TEST`。如果涉及安全边界、破坏性操作、外部副作用、人工验收或发布风险，路线至少需要一个人工审核点。Orchestrator 为每种任务类型绑定固定 Worker，并且一次只运行一个路线步骤。

| Agent | 职责 |
| --- | --- |
| `manager-agent` | 理解用户意图、提议并确认路线、处理审批、向用户转达进度。 |
| `requirement-agent` | 梳理范围、边界、假设和验收标准。 |
| `architect-agent` | 设计架构、接口、风险和测试策略。 |
| `developer-agent` | 在隔离 Git worktree 中执行授权实现。 |
| `test-agent` | 在授权隔离边界内测试并提供事实证据。 |
| `review-agent` | 独立进行代码审查并报告回归风险。 |
| `release-agent` | 只评估发布准备度和回滚方案，不执行部署。 |
| `hr-agent` | 受保护的后台检查者，不参与路线、不接受 Manager 委派，也不直接联系用户。 |

## JSON 与 Agent 通信

Manager 请求使用 [`contracts/manager-request.schema.json`](contracts/manager-request.schema.json) 校验。确认后的 `route_plan` 以冻结 JSONB 保存到 `runs`。

每个任务由 Orchestrator 生成 context manifest、任务消息、隔离 worktree、artifact 根目录和唯一的原始输出路径。Worker 之间不直接通信，不写 PostgreSQL，不派发任务，也不修改 Monitor。Worker 只能写入指定 `<artifact_root>/.agent-raw/**`，并返回一个符合 `result.schema.json` 的对象。

JSON 摄取流程采用 fail-closed 策略：

```text
原始 JSON / JSONL
-> 清理 BOM、Markdown fence，并处理唯一候选
-> Ajv Schema 与身份校验
-> 路径、哈希和引用校验
-> 原子发布
-> 登记 artifact
-> 更新 execution/task/run
-> 写入 Kernel 事件
-> 通知 Manager
```

非法 JSON、多候选、截断、身份不一致或路径逃逸都会被拒绝，同时保留原始文件和脱敏后的失败回执。Agent 之间只能通过已发布 artifact、context manifest 和 Kernel facts 传递上下文。

## HR 检查与日报

Monitor 直接读取已安装 OpenClaw Agent 会话 JSONL 中可见的 `user` 和 `assistant` 消息。system prompt、thinking、工具参数、工具输出和凭据会被排除或脱敏，不会展示给用户，也不会交给 HR。

每出现一条非 HR Agent 的 assistant 文本，本地规则立即检查 `可能`、`我觉得`、`猜测`、`不确定`、`maybe`、`perhaps`、`I think`、`guess` 等可配置词语。命中后会写入 `HR_KEYWORD_ALERT` 事件，Monitor 立即显示告警，并异步创建 HR 检查任务。HR 没有 JSON Schema，不阻断工作流；其原始可见输出经过同一套脱敏后直接展示在 Monitor。

业务任务进入终态时，会创建 `TASK_DAILY_REPORT` 任务，请 HR 总结本轮各业务 Agent 做过的事情、错误或限制以及待关注事项。日报只用于观察，不参与工作流状态推进。

需要暂停 HR 时，在项目根 `.env` 设置 `OPENCLAW_HR_ENABLED=false`，然后重启正在运行的 Orchestrator、HR Runner 和 Monitor。禁用期间不会创建 `HR_KEYWORD_ALERT` 或新的 HR 任务，也不会执行已有待办；工作流、Manager 通知和 Monitor 的只读功能不受影响。已有 `hr_jobs` 会保留，恢复为 `true` 后才会继续执行。

## 从零部署

以下顺序用于新的机器或新的项目 checkout：安装依赖、启动 PostgreSQL、安装 Agent，最后启动前台 Orchestrator。不要在新部署中执行 `migrate-stategraph.mjs`；它仅用于从旧 StateGraph 安装迁移历史数据。

前置条件：Node.js 22.5+、npm、Git、OpenClaw CLI，以及 Docker Desktop/Engine。Linux 还需要 `jq`（`install.sh` 与 `validate-install.sh` 使用它）。OpenClaw CLI 必须已能连接到一个可用的模型提供方；本项目不会替用户创建模型提供方或写入凭据。

Manager 也会在 Docker sandbox 中运行：容器根文件系统为只读、没有网络，只挂载其自身 workspace；其工具集不包含命令执行、补丁、浏览器或预览能力，因此不能直接修改业务仓库、构建或运行项目。Manager 的 workspace 协议只允许它在 `.orchestrator/requests/` 提交请求 JSON。首次安装前请确认本机已有 `openclaw-test-node:22-slim` 镜像（或按项目既有 sandbox 镜像流程构建）。

先在项目根目录确认基础工具可用：

```powershell
node --version
npm --version
git --version
openclaw --version
docker version
openclaw config validate --json
openclaw gateway status
```

### 1. 安装 Node 依赖并创建环境文件

```powershell
npm ci
Copy-Item .env.example .env
```

```bash
npm ci
cp -n .env.example .env
```

编辑 `.env`，至少确认以下值。若修改数据库密码，`OPENCLAW_PG_URL` 中的密码必须保持一致；含 `@`、`:`、`/` 等字符时需按 URL 编码。

```text
OPENCLAW_PG_URL=postgresql://openclaw:password@localhost:5432/openclaw
OPENCLAW_KERNEL_SCHEMA=kernel
```

### 2. 启动 PostgreSQL 并确认健康

以下 Docker 命令可同时用于 PowerShell、cmd 和 Bash；请完整复制为一行。它只绑定本机回环地址，不会向局域网公开 PostgreSQL 端口。

```text
docker run --detach --name openclaw-pg --restart unless-stopped --health-cmd "pg_isready -U openclaw -d openclaw" --health-interval 5s --health-timeout 5s --health-retries 12 -e POSTGRES_USER=openclaw -e POSTGRES_PASSWORD=password -e POSTGRES_DB=openclaw -p 127.0.0.1:5432:5432 postgres:16
```

确认容器显示 `healthy` 后再继续：

```powershell
docker inspect --format '{{.State.Health.Status}}' openclaw-pg
```

```bash
docker inspect --format '{{.State.Health.Status}}' openclaw-pg
```

如果机器上已有同名容器，不要重复执行 `docker run`；改用 `docker start openclaw-pg`，然后再次确认健康状态。

### 3. 创建并验证 Control Kernel schema

```powershell
npm run kernel:schema
npm run kernel:status
```

两个命令都必须成功；第二个命令应返回 `runs`、`tasks`、`executions`、`artifacts`、`events`、`approvals`、`notifications` 和 `hr_jobs` 表。

### 4. 安装 OpenClaw Agent 和 runtime

Windows：

```powershell
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1
```

Linux：

```bash
bash scripts/install.sh --runtime-root runtime
bash scripts/install.sh --apply --yes --runtime-root runtime
bash scripts/validate-install.sh
```

### 5. 确认 OpenClaw Gateway 并启动 Orchestrator

`openclaw gateway status` 必须显示 Gateway 可达。若本机尚未运行 Gateway，在单独终端以前台方式启动它：

```text
openclaw gateway run
```

随后在另一个独立终端以前台方式运行 Orchestrator：

```powershell
npm run orchestrator:start
```

另开终端确认服务健康：

```powershell
npm run orchestrator:status
```

可选：再开一个终端启动只读 Monitor：`npm run monitor:start`。至此，Manager 写入的请求会由 Orchestrator 自动消费，无需再手动运行 `scan` 或 `run`。

## 运行 Orchestrator

Manager 请求位于已安装 Manager workspace：

```text
runtime/agents/manager-agent/workspace/.orchestrator/
  requests/
  receipts/
```

在项目根目录运行请求处理器：

```powershell
# 只校验一个 Manager request，不消费请求
node scripts/orchestrator-cli.mjs validate-request --project-root . --request-file <request-file>

# 只处理一个已校验的 Manager request，不扫描其他 request
node scripts/orchestrator-cli.mjs process-request --project-root . --manager-workspace runtime/agents/manager-agent/workspace --request-file <request-file>

# 扫描并处理 Manager 请求，推进活动中的串行路线，并执行待处理 HR 任务
node scripts/orchestrator-cli.mjs scan --project-root .

# 推进一个工作流、按 notification ID 重试持久化 Manager 通知或查看事实
node scripts/orchestrator-cli.mjs run --project-root . --workflow-id WF-example
node scripts/orchestrator-cli.mjs retry-notifications --project-root . --notification-id NTF-example
node scripts/orchestrator-cli.mjs status --project-root .
```

Linux 使用相同的 `node` 命令。请求处理和通知重试可以安全重复运行；回执和 PostgreSQL 事实会保证幂等性。

### 前台常驻轮询

日常运行应启动前台 Orchestrator 服务，而不是反复手动执行 `scan` 或 `run`。服务会每秒消费 Manager 请求、推进活动工作流、投递通知和运行待处理 HR 任务；同一 runtime 只能有一个实例持有前台服务锁。

```powershell
npm run orchestrator:start
# 或
pwsh -NoProfile -File scripts/start-orchestrator.ps1 -PollMs 1000
```

```bash
npm run orchestrator:start
# 或
bash scripts/start-orchestrator.sh
```

服务前台运行，关闭终端时会进入受控停止。日常优雅停止请从另一个终端执行：

```powershell
npm run orchestrator:status
npm run orchestrator:stop
```

`stop` 会先停止接收新工作并进入 `DRAINING`；默认最多等待 120 秒让当前 Agent 结束，超过时间才取消其 OpenClaw 子进程。服务状态位于 `runtime/orchestrator/service/foreground.status.json`，用于查看心跳、轮询次数和最近错误。当前阶段不注册 Windows 服务或计划任务。

## Monitor

启动本地 Monitor：

```powershell
npm run monitor:start
# 或
pwsh -NoProfile -File scripts/start-monitor.ps1 -Port 4319
```

```bash
OPENCLAW_PROJECT_ROOT=/absolute/project/path \
OPENCLAW_RUNTIME_ROOT=/absolute/project/path/runtime \
MONITOR_PORT=4319 \
bash scripts/start-monitor.sh
```

打开 `http://127.0.0.1:4319/` 或 `http://localhost:4319/`。两个 loopback 主机名都被接受，其他来源和端口会被拒绝。Monitor 展示 PostgreSQL 工作流和任务、Manager 投递状态、待审批、脱敏后的实时 Agent 会话、未绑定会话、HR 告警、HR 输出和任务日报，并通过单条 SSE 流更新；重连游标保存在本地。

所有公开 Monitor 修改接口都返回 `MONITOR_READ_ONLY`。唯一的内部例外是 `POST /internal/notifications/retry`：该接口只接受 loopback 请求和令牌，只能重试已有的 Manager 通知，不能创建、推进、审批、取消或重做工作流。

主要 Monitor API：

- `GET /api/health`
- `GET /api/workflows`
- `GET /api/workflows/stream`
- `GET /api/agents`、`GET /api/agents/:id/sessions`、`GET /api/agents/:id/sessions/:session/messages`
- `GET /api/hr/alerts`、`GET /api/hr/jobs`、`GET /api/hr/outputs`
- `GET /api/notifications`

更多说明见 [docs/monitoring.md](docs/monitoring.md)。

## 更新已安装 Agent

当修改 Agent workspace、`agents/common/`、Agent package、runtime bundle、sandbox/model/tool 配置或安装行为时，需要更新已安装 Agent：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

### 从 `.env` 注入模型与统一思考强度

在项目根 `.env` 中设置 `OPENCLAW_AGENT_<AGENT_ID>_MODEL`（连字符改为下划线并转大写），例如 `OPENCLAW_AGENT_DEVELOPER_AGENT_MODEL=provider/model-id`。所有 Agent 的思考强度由 `OPENCLAW_THINKING_LEVEL` 统一设置，支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`。然后运行：

```text
node scripts/inject-openclaw-models.mjs
node scripts/inject-openclaw-models.mjs --apply --yes
```

脚本默认只预演；Apply 会先执行 `config patch --dry-run`，随后一次性写入 `agents.list[*].model` 和 `agents.defaults.thinkingDefault`，最后执行 `openclaw config validate --json`。

普通更新不需要停止 Gateway。只有 Agent 注册或受管理 runtime 损坏时，才先手动停止 OpenClaw Gateway，再执行安全重装：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

项目没有独立的 Bash 重装脚本；Linux 恢复路径使用 PowerShell 7 执行上述命令。

## 测试

```powershell
npm test
```

```bash
npm test
```

也可以单独运行：`npm run test:orchestrator`、`npm run test:hr`、`npm run test:monitor` 和 `npm run test:kernel`。Kernel 测试需要可访问的 `OPENCLAW_PG_URL`，应确认测试通过，而不是仅被跳过。Manager request 写入队列前可用 `node scripts/orchestrator-cli.mjs validate-request --project-root . --request-file <request-file>` 做完整 JSON Schema 和路线规则校验；该命令只读，不会消费请求。
