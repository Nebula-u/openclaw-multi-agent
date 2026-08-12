# openclaw-multi-agent

本项目使用 OpenClaw worker Agent 与本地 Orchestrator 完成受控的多 Agent 开发流程。

状态、派发、结果接收和重试由本地代码决定；Agent 只执行已分配任务、修改指定 worktree，并写入暂存结果。看板为只读，只显示任务阶段、状态、负责 Agent 和用户可见对话。

## 当前功能

- `runtime/control/control.db` 同时保存业务控制事实和 LangGraph checkpoint：业务表是 workflow/task/run/dispatch 的唯一事实源，checkpoint 表只保存 Graph 续跑位置和 pending writes。
- 轻量 LangGraph `StateGraph` 是确定性执行编排层；固定代码负责状态分类、合法边校验、派发与续跑，Manager 只在 `NEEDS_TASK`、`HOLD`、`FAILED` 等有限决策点介入。
- 本地 Orchestrator 从已验证 task 固定派生目标 Agent、session 和派发回执；Agent 不可自行派发或改状态。
- Agent JSON/JSONL 只能写入 `<artifact_root>/.agent-raw/**`；本地代码统一清洗、Ajv 校验、原子发布最终文件。
- JSON 解析、路径安全或 Schema 校验失败时，本地代码保留原始暂存文件，并写入 `.orchestrator-ingest/*.failure.json` 和 `.orchestrator-ingest/validation-errors.jsonl`。
- Monitor 不提供写入、重试、催办或与 Agent 交互的入口；可显示全部已创建 Agent、持久 session 和完整 user/assistant 文本，但不展示思考、工具调用、工具结果、prompt、凭据、路径和控制细节。
- 模型通过配置按 Agent 静态选择；Agent 无权自行切换。通用 provider 模板使用 OpenAI Chat Completions、128k 上下文和 49,152 输出上限，Manager 单 session 累计 token 上限为 200k。

## 前置条件

- 已安装 OpenClaw，`openclaw --version` 可用。
- Node.js 22.5+、npm、Git。
- Windows 使用 PowerShell 7；Bash 安装脚本还需要 `jq`。

Linux 服务器（以下以 Ubuntu/Debian 为例）从零安装系统依赖、Node.js 22 和 OpenClaw：

```bash
# Linux（Ubuntu/Debian）
sudo apt-get update
sudo apt-get install -y curl git jq
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g openclaw
node --version
openclaw --version
```

首次安装依赖：

```powershell
npm install
```

## 启动方式

### 1. 启动 OpenClaw Gateway

```powershell
openclaw gateway start
openclaw gateway status
```

状态应显示 `Runtime: running` 与 `Connectivity probe: ok`。

### 2. 初始化本地 Orchestrator

`scripts/orchestrator.mjs` 是项目源码中的控制脚本，不是 OpenClaw Agent 的 runtime 文件。`init` 只初始化本地 Orchestrator capability，不会安装、复制或生成
`runtime/scripts/orchestrator.mjs`；因此 `runtime/scripts` 不存在是正常的。Control DB、capability 和 Agent workspace 属于 `runtime/`，脚本仍然从项目根目录的 `scripts/` 执行。

必须把 `<project-root>` 替换为本项目根目录的绝对路径。若当前 PowerShell 目录已经是项目根目录，可以执行：

```powershell
$ProjectRoot = (Get-Location).Path
$Orchestrator = Join-Path $ProjectRoot 'scripts\orchestrator.mjs'
if (-not (Test-Path -LiteralPath $Orchestrator -PathType Leaf)) {
  throw "项目根目录错误，找不到 $Orchestrator"
}
node $Orchestrator init --project-root $ProjectRoot
```

如果命令由 `runtime/agents/manager-agent/workspace` 或其他非项目目录发起，不能使用相对路径 `scripts/orchestrator.mjs` 和 `--project-root .`，应显式指定项目根目录：

```powershell
$ProjectRoot = 'D:\path\to\openclaw-multi-agent'
$Orchestrator = Join-Path $ProjectRoot 'scripts\orchestrator.mjs'
if (-not (Test-Path -LiteralPath $Orchestrator -PathType Leaf)) {
  throw "项目根目录错误，找不到 $Orchestrator"
}
node $Orchestrator init --project-root $ProjectRoot
```

初始化后的检查应满足：`<project-root>\scripts\orchestrator.mjs` 存在，
`<project-root>\runtime\control\.local-orchestrator.capability` 存在；不应检查
`<project-root>\runtime\scripts\orchestrator.mjs`。不要读取、复制或打印 capability 文件内容。

### 3. 启动只读看板

```powershell
npm run supervisor:start
```

另开浏览器打开 `monitor/ui/index.html`。默认 Supervisor API 为 `http://127.0.0.1:4319`。控制台左侧列出所有已创建 Agent（包括未激活或已结束），右侧可切换 session 并查看持久化的 user/assistant 对话历史。

启动前检查：

```powershell
npm run supervisor:check
```

### 4. 验证运行环境

```powershell
openclaw config validate --json
node scripts/runtime-bundle.mjs verify --project-root . --runtime-root runtime
node scripts/control-kernel.mjs snapshot --project-root .
```

### 5. 执行一个 StateGraph 编排轮次

先由 Manager 完成 workflow bootstrap 和当前阶段所需 task package 注册；随后执行：

```powershell
$ProjectRoot = 'D:\path\to\openclaw-multi-agent'
$Orchestrator = Join-Path $ProjectRoot 'scripts\orchestrator.mjs'
node $Orchestrator workflow-run `
  --project-root $ProjectRoot `
  --workflow-id WF-example
```

每次调用最多提交一个 workflow transition。动态路由依次经过安全守卫、结构化结果分类、阶段策略、合法边校验和命令构建五层。返回 `NEEDS_TASK`、`WAITING_HUMAN`、`HOLD`、`RUNNING` 或 `TERMINAL` 时应停止，并根据 Control DB 中的事实准备任务、处理审批或恢复流程。StateGraph 使用同一个 `control.db` 中的 SQLite checkpointer；Supervisor 可按 `workflow_id` 恢复 checkpoint 并继续有界 Graph turn。

工作 Agent 的单次进程、dispatch lease、工具执行宽限与 JSON 契约调用统一上限为 **900 秒**。Manager wake 和健康检测保留较短上限，以便监督流程及时响应。

## Agent 角色

| Agent | 职责 |
| --- | --- |
| `manager-agent` | 与用户沟通、说明已验证事实、提交工作流意图；不直接派发、不改状态。 |
| `requirement-agent` | 整理需求、验收标准与追踪关系。 |
| `architect-agent` | 输出架构、接口、任务拆分、风险与测试策略。 |
| `developer-agent` | 在 `runtime/worktrees/<workflow>/<task>/<run>/repo` 实现代码。 |
| `review-agent` | 独立审查代码、测试和安全问题。 |
| `test-agent` | 补充并执行测试；当前为本地无 sandbox 模式。 |
| `release-agent` | 汇总发布前验证结论，不执行部署。 |

本地 Orchestrator 不是 LLM Agent。它负责读取 READY task、选择固定 worker、生成 session/receipt、调用 OpenClaw、接收暂存输出、验证结果并更新 Control DB。

## JSON/JSONL 结果与错误日志

Agent 只可写 `.agent-raw` 暂存文件，不能写最终 `output/*.json`。本地入库顺序为：

```text
.agent-raw 原始文件
→ 确定性清洗与解析
→ Ajv Schema 校验
→ 原子发布 output 文件
→ 成功 receipt 或失败 receipt/validation-errors.jsonl
→ Control DB 完成或失败状态
```

错误证据位于任务的 artifact root：

- `.agent-raw/**`：原始无效输出。
- `.orchestrator-ingest/<输出相对路径>.failure.json`：该输出的失败收据、错误码和结构化诊断。
- `.orchestrator-ingest/validation-errors.jsonl`：追加式错误日志，记录 Agent、workflow/task/run、原文 hash、脱敏摘要、Ajv/解析错误和时间。

多条候选 JSON、截断、非 JSON、路径逃逸、软链接和 Schema 不匹配都会被拒绝；系统不会猜测、修复业务字段或把聊天内容当作结果。

## 安装或更新 Agent

源码中的 Agent 提示、规则、模板或受管配置变更后，优先使用幂等同步更新，**不删除、不重装现有 Agent**。普通 `install.ps1` / `install.sh` 会校验 Agent ID 与 workspace 路径：现有且兼容的 Agent 显示为 `KEEP`，不会执行 `openclaw agents add`；随后只同步 workspace、共享规则、模板和受管配置。脚本只处理本项目 manifest 声明的 7 个 Agent，不处理 `main`、其他项目 Agent 或未注册的 `dialogue-agent`。

更新前应确认没有正在运行的 workflow/task，再停止 Gateway。必须先执行 dry-run：7 个项目 Agent 都应显示为现有兼容项；如果出现 `ADD`、路径冲突或同名冲突，应停止并核对 runtime 路径，不要继续 apply。

### Windows PowerShell：原地更新，不重装

在项目根目录执行：

```powershell
# 1. 确认没有运行中的任务，然后停止 Gateway
openclaw gateway stop

# 2. Dry-run
pwsh -NoProfile -File ".\scripts\install.ps1" `
  -RuntimeRoot ".\runtime"

# 3. 确认全部为 KEEP 后执行原地更新
pwsh -NoProfile -File ".\scripts\install.ps1" `
  -Apply -Yes -RuntimeRoot ".\runtime"

# 4. 校验同步结果并重新启动 Gateway
openclaw config validate --json
node ".\scripts\runtime-bundle.mjs" verify `
  --project-root "." --runtime-root ".\runtime"
node ".\scripts\orchestrator.mjs" init --project-root "."
openclaw gateway start
openclaw gateway status
```

只更新指定 Agent 时，Windows 可在 dry-run 和 apply 命令中同时加入例如 `-AgentIds 'manager-agent,architect-agent'`；两次命令的 Agent 范围必须一致。

### Linux 服务器：原地更新，不重装

在项目根目录执行：

```bash
project_root="$(pwd -P)"
runtime_root="$project_root/runtime"
install_script="$project_root/scripts/install.sh"

# 1. 确认没有运行中的任务，然后停止 Gateway
openclaw gateway stop

# 2. Dry-run：所有已安装项目 Agent 都应是兼容项，不应计划创建新 Agent
bash "$install_script" --runtime-root "$runtime_root"

# 3. 原地同步 workspace、规则、模板与受管配置；不会删除或重建现有 Agent
bash "$install_script" --apply --yes --runtime-root "$runtime_root"

# 4. 校验同步结果并重新启动 Gateway
openclaw config validate --json
node "$project_root/scripts/runtime-bundle.mjs" verify \
  --project-root "$project_root" --runtime-root "$runtime_root"
node "$project_root/scripts/orchestrator.mjs" init --project-root "$project_root"
openclaw gateway start
openclaw gateway status
```

apply 前会把 OpenClaw 配置备份到 `runtime/control/config-snapshots/`。以上更新流程不调用 `scripts/reinstall-agents.ps1`，也不调用 `openclaw agents delete`；只有明确需要删除并重建 Agent 时才使用重装脚本。

### 按 Agent 静态配置模型

当前 package 中的默认模型保持不变。需要切换时复制 `config/agent-models.example.json`，分别填写各 Agent 的 `provider/model`，然后在 dry-run 和 apply 中加入同一个模型配置路径：

```powershell
Copy-Item '.\config\agent-models.example.json' '.\config\agent-models.json'
pwsh -NoProfile -File '.\scripts\install.ps1' `
  -RuntimeRoot '.\runtime' `
  -ModelConfig '.\config\agent-models.json'
```

Linux 对应使用 `--model-config config/agent-models.json`。Provider 模板见 `config/openai-provider.example.json`；凭据必须由 OpenClaw auth/profile 管理。不存在运行时自动路由或 Agent 自主切换。完整说明见 [模型配置与静态路由](docs/model-routing.md)。

## 将 Monitor 部署为 Linux 服务

`npm run supervisor:start` 在 Windows 和 Linux 中相同；Linux 服务器需要常驻部署时，可使用 systemd：

```bash
# Linux：将 <project-root>、<linux-user>、<linux-group> 替换为实际值
sudo tee /etc/systemd/system/openclaw-monitor.service >/dev/null <<'EOF'
[Unit]
Description=OpenClaw SDLC Monitor
After=network.target

[Service]
Type=simple
User=<linux-user>
Group=<linux-group>
WorkingDirectory=<project-root>
Environment=OPENCLAW_PROJECT_ROOT=<project-root>
Environment=OPENCLAW_RUNTIME_ROOT=<project-root>/runtime
Environment=MONITOR_PORT=4319
ExecStart=/usr/bin/env bash <project-root>/scripts/start-monitor.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-monitor
sudo systemctl status openclaw-monitor --no-pager
curl -fsS http://127.0.0.1:4319/api/health
```

### 将实时 Monitor 发布到 Tomcat HTTPS

适用于 Tomcat 10 直接承载 HTTPS 的 Linux 服务器。该方案把静态看板部署到 `/monitor/`，并在同一 Tomcat context 内部代理 `/monitor/api/*` 到本机 Monitor；端口 `4319` 继续只监听 `127.0.0.1`，不应配置防火墙公网放行。

```bash
# 1. 从模板生成与当前 Linux 用户、项目路径和 Node 路径匹配的 systemd 单元
project_root="$(pwd -P)"
run_user="$(id -un)"
run_group="$(id -gn)"
node_bin="$(dirname "$(command -v node)")"
unit_file="$(mktemp)"
sed -e "s|__RUN_USER__|$run_user|g" \
    -e "s|__RUN_GROUP__|$run_group|g" \
    -e "s|__PROJECT_ROOT__|$project_root|g" \
    -e "s|__NODE_BIN__|$node_bin|g" \
    deploy/openclaw-monitor.service > "$unit_file"
sudo install -o root -g root -m 0644 "$unit_file" /etc/systemd/system/openclaw-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-monitor.service

# 2. 编译 Servlet 并部署到 Tomcat 的 /monitor context
bash scripts/deploy-monitor-tomcat.sh

# 3. 验证本机 API 与 HTTPS 同源代理
curl -fsS http://127.0.0.1:4319/api/health
curl -fsS https://<domain>/monitor/api/health
```

页面地址为 `https://<domain>/monitor/`。上述 HTTPS 验证要求域名证书已被客户端信任；仅在排查证书问题时才临时使用 `curl -k`。Tomcat 自动发现 exploded webapp 可能需要数秒；若首次请求返回 404，等待部署日志完成后重试。页面会显示工作流、任务和 Agent 状态，应在 Tomcat 前增加访问认证或 IP 白名单。

回滚时，停止 `openclaw-monitor.service`，恢复或移除 `/var/lib/tomcat10/webapps/monitor/`；该目录与 Tomcat `ROOT` 应用独立。

## 测试

```powershell
npm test
```

问题、已完成整改和仍需部署侧处理的风险见 [docs/problem](docs/problem/)。
