# OpenClaw Multi-Agent

`openclaw-multi-agent` 是一个运行在单机上的 OpenClaw 工作流系统：Manager 接收需求，Orchestrator 按路线调度多个 Agent，SQLite 保存工作流状态，Monitor 提供本机网页视图。

## 环境要求

- Node.js 22.13 或更高版本（使用内置 `node:sqlite`）。
- Git。
- 已安装并登录、可正常运行的 [OpenClaw](https://openclaw.ai/)。
- Windows PowerShell 7，或 Linux Bash。
- 使用 TEST 的 Docker sandbox 时，需要可由 OpenClaw 访问的 Linux Docker Engine。

项目不需要 PostgreSQL、Redis 或独立的 SQLite npm 包。

## 安装与配置

在项目根目录执行：

```bash
npm install
cp .env.example .env
```

按需编辑 `.env`。常用配置包括：

```text
OPENCLAW_KERNEL_DB_PATH=runtime/control/kernel.db
OPENCLAW_KERNEL_BUSY_TIMEOUT_MS=5000
OPENCLAW_KERNEL_LEASE_SECONDS=120
OPENCLAW_HR_ENABLED=true
OPENCLAW_HR_AUTO_MODE=off
OPENCLAW_TEST_SANDBOX_ENABLED=true
```

初始化数据库：

```bash
npm run kernel:schema
npm run kernel:status
```

将项目 Agent 安装到 OpenClaw：

Windows：

```powershell
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
```

Linux：

```bash
bash scripts/install.sh --apply --yes --runtime-root runtime
```

安装或更新 Agent 后，将 `.env` 中的模型和思考级别同步到 OpenClaw：

```bash
openclaw models status --agent manager-agent --json
node scripts/inject-openclaw-models.mjs --apply --yes
```

Windows PowerShell 使用同一条 Node 命令。脚本会读取 `OPENCLAW_AGENT_<ID>_MODEL` 和 `OPENCLAW_THINKING_LEVEL`；不需要配置模型时可跳过此步骤。

## 启动与使用

启动 Orchestrator（保持该终端运行）：

```bash
npm run orchestrator:start
```

查看状态或停止：

```bash
npm run orchestrator:status
npm run orchestrator:stop
```

另开终端启动 Monitor：

```bash
npm run monitor:start
```

浏览器访问 <http://127.0.0.1:4319/>；停止 Monitor：

```bash
npm run monitor:stop
```

需求和审批由 OpenClaw Manager 会话发起，Orchestrator 负责执行；Monitor 主要用于查看运行状态和处理人工审批。首次使用前请确保 OpenClaw Gateway 已启动。

## 测试

运行完整测试套件：

```bash
npm test
```

按模块运行：

```bash
npm run test:kernel
npm run test:orchestrator
npm run test:hr
npm run test:monitor
npm run test:runtime-bundle
```

Kernel 测试使用临时 SQLite，不需要外部数据库。启用 TEST Docker sandbox 的测试需要确保 Docker daemon 和 `openclaw-test-node:22-slim` 镜像可用。

安装脚本默认是 dry-run；需要检查安装结果时可运行：

```powershell
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
```

```bash
bash scripts/install.sh --runtime-root runtime
bash scripts/validate-install.sh --runtime-root runtime
```

更多架构和运维背景请参阅 `docs/` 目录。

## Agent 安全重装

只有普通更新无法恢复、注册状态或受管理 runtime 损坏时才使用安全重装。该脚本仅支持 Windows；执行前必须手动停止 OpenClaw Gateway，并显式确认：

```powershell
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

Linux 没有等价的重装脚本；请先运行安装验证，必要时使用 `scripts/install.sh --apply --yes` 重新安装。不要在 Gateway 运行时执行安全重装。
