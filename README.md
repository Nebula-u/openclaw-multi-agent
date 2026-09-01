# OpenClaw Multi-Agent

`openclaw-multi-agent` 是一个单机部署的 OpenClaw 工作流系统。Manager 在原生会话中确认路线，Node Orchestrator 串行调度各角色 Agent，SQLite Control Kernel 保存工作流事实，Git 保存每个 Agent 的代码快照，Monitor 提供本机只读视图。

## 架构

```text
Manager native Session
        │ schema-valid request / decision
        ▼
Node Orchestrator ───── OpenClaw Agent Sessions
        │                         │
        │                         └─ thinking/reasoning + final output
        ├─ SQLite: runtime/control/kernel.db
        │   runs / tasks / executions / artifacts
        │   approvals / notifications / hr_jobs / snapshots
        ├─ Git: worktree + commit + refs/openclaw/snapshots/*
        └─ task files: work/<project>-<task>/{repo,input,output,logs}

Monitor ── SQLite facts + redacted Sessions
```

边界：

- SQLite 只支持同一台机器上的本地磁盘，不得放在 SMB、NFS、云盘同步目录，也不得由多台服务器共享。
- 前台 Orchestrator、一次性写 CLI、schema 初始化和 HR runner 共用单写者锁；Monitor 与只读 CLI 使用 `query_only` 连接。
- Git 是代码版本、差异和回滚的唯一引擎；SQLite `snapshots` 只保存索引。
- 没有事件哈希链、数据库 revision CAS 或 artifact 内容寻址副本。
- 本版本从空 SQLite 开始，不迁移 PostgreSQL 或旧 StateGraph 历史数据。
- 后续任务文件位于项目根的 `work/`，名称采用目标项目与任务摘要；已有 `runtime/artifacts/` 与 `runtime/worktrees/` 不会迁移或重命名。

详细说明见 [架构](docs/architecture.md)、[Git 快照](docs/git-worktree-strategy.md)、[HR 审查](docs/hr-review.md) 和 [监控](docs/monitoring.md)。

## 环境要求

- Node.js 22.13 或更高版本；项目使用内置 `node:sqlite`。
- Git。
- 已安装并可运行的 OpenClaw。
- Windows PowerShell 7，或 Linux Bash。

不需要 PostgreSQL、Redis、Docker 数据库容器或额外 SQLite npm 包。`TEST` Docker sandbox 默认开启（`OPENCLAW_TEST_SANDBOX_ENABLED=true`），此模式必须部署在原生 Linux 服务器或 WSL2 Linux 发行版上，并使用可由 OpenClaw 访问的 Linux Docker Engine；Docker Desktop 的单一可写 workspace bind 无法可靠提供 per-run 只读 submount。Windows 上若 Docker sandbox 无法使用，可在 `.env` 设置 `OPENCLAW_TEST_SANDBOX_ENABLED=false`；TEST 会改在分配的本地 worktree 执行并明确记录 `UNSANDBOXED_LOCAL`，不再要求 Docker staging 或 attestation。此本地模式隔离较弱，仍禁止联网、安装依赖、访问凭证、启动服务及系统配置修改。

### 为 TEST 准备 WSL2 Linux 沙箱（Windows 主机）

`TEST_SANDBOX_NATIVE_LINUX_REQUIRED` 只会在 `OPENCLAW_TEST_SANDBOX_ENABLED=true` 时出现；它表示 Orchestrator 仍运行在 Windows（`process.platform=win32`）。可选择按以下命令迁移到 WSL2 Linux，或在 Windows 的 `.env` 设置 `OPENCLAW_TEST_SANDBOX_ENABLED=false` 后重新安装 Agent，以本地模式运行 TEST。

1. 在**管理员 PowerShell**安装 WSL2 Ubuntu；若系统提示，重启 Windows 后再继续：

```powershell
wsl --install -d Ubuntu
wsl --status
wsl -d Ubuntu
```

2. 在 Ubuntu 终端启用 systemd、安装 Docker Engine、Git 和 Node.js 22。执行完第一段后退出 Ubuntu；随后回到 PowerShell 执行 `wsl --shutdown`，再重新打开 Ubuntu，才能使用 `systemctl`：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
exit
```

```powershell
wsl --shutdown
wsl -d Ubuntu
```

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git docker.io
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
exit
```

再次从 PowerShell 打开 Ubuntu（使新的 `docker` 用户组生效），并确认 Linux、Docker 与 Node 都可用：

```powershell
wsl -d Ubuntu
```

```bash
node --version
docker version
docker run --rm hello-world
```

3. 把项目放到 WSL 的 Linux 文件系统（例如 `/home/<user>/src/`），**不能**直接从 `/mnt/f/...` 启动 Orchestrator。若当前代码尚未推送远端，可从 Windows 工作目录复制；已有远端仓库时也可以改用 `git clone`：

```bash
mkdir -p ~/src
cp -a /mnt/f/MicroConnect/project/openclaw-multi-agent ~/src/
cd ~/src/openclaw-multi-agent
pwd
npm install
```

`pwd` 必须显示 `/home/...`，而不是 `/mnt/f/...`。在此 Linux 环境中单独安装/登录 OpenClaw；本项目不提供 OpenClaw 安装命令。先确认 `openclaw --version` 可运行，再继续：

```bash
openclaw --version
docker build --tag openclaw-test-node:22-slim --file deploy/sandbox/Dockerfile.test-node .
docker image inspect openclaw-test-node:22-slim
bash scripts/install.sh --apply --yes --runtime-root runtime
npm run orchestrator:start
```

迁移前先在 Windows 项目目录执行 `npm run orchestrator:stop`，确保同一 workflow 不会同时被 Windows 与 Linux 两个 Orchestrator 写入。Monitor 也必须从同一个 WSL Linux 项目目录启动，不能让 Windows 跨文件系统读取 Linux SQLite；Windows 浏览器可直接访问 WSL Monitor 监听的 `http://127.0.0.1:4319/`。

首次启用 TEST 前，在项目根目录构建 test-agent 镜像：

```text
docker build --tag openclaw-test-node:22-slim --file deploy/sandbox/Dockerfile.test-node .
```

镜像构建可联网下载基础镜像和系统包；实际 TEST 容器始终使用 `network: none`。当 sandbox 开启时，Docker daemon、镜像或 OpenClaw sandbox workspace 不可用会使 TEST fail closed；设置 `OPENCLAW_TEST_SANDBOX_ENABLED=false` 后则改走受限的本地 worktree 模式。

Docker 模式的 TEST staging 是全局强制串行的：同一时刻只允许一个 TEST 任务使用 test-agent 的 `.task-sandbox` workspace。未启用 Docker sandbox 时不创建该 staging workspace。

## 首次安装

### 1. 安装 Node 依赖

```text
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`。核心配置：

```text
OPENCLAW_KERNEL_DB_PATH=runtime/control/kernel.db
OPENCLAW_KERNEL_BUSY_TIMEOUT_MS=5000
OPENCLAW_KERNEL_LEASE_SECONDS=120
OPENCLAW_HR_ENABLED=true
OPENCLAW_HR_AUTO_MODE=off
```

相对数据库路径按项目根目录解析。服务器部署时应把 `runtime/` 放在本机持久化磁盘。

### 3. 初始化或升级 Kernel

```text
npm run kernel:schema
npm run kernel:status
```

命令会幂等创建八张表，并启用 WAL、外键、5 秒 busy timeout 和 `synchronous=FULL`。Kernel 使用 `PRAGMA user_version` 记录 schema 版本；已知的旧 SQLite 结构会在单写者锁内事务迁移并保留事实，未知结构漂移会失败关闭。生产升级前应先停止 Orchestrator 并备份 `runtime/control/kernel.db`。

### 4. 安装或更新 Agent

Windows：

```text
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
```

Linux：

```text
bash scripts/install.sh --apply --yes --runtime-root runtime
```

日常更新不需要停止 OpenClaw Gateway。

模型路由从项目根目录的 `.env` 读取。更新 Agent 后，先查看已注册 Agent 的当前模型，再将 `.env` 中所有 `OPENCLAW_AGENT_<ID>_MODEL` 和 `OPENCLAW_THINKING_LEVEL` 写入 OpenClaw：

```text
openclaw models status --agent manager-agent --json
node scripts/inject-openclaw-models.mjs --apply --yes
```

本项目更新了 Agent package、common rules 或 test-agent workspace 时，必须在每台已安装机器执行上述对应的普通更新命令，使 installed Agent 获得新的 sandbox 配置与规则。

### 5. 启动 Orchestrator

前台运行：

```text
npm run orchestrator:start
```

另一个终端查看或停止：

```text
npm run orchestrator:status
npm run orchestrator:stop
```

`orchestrator:status` 会把进程已死亡或 heartbeat 过期的旧状态文件显示为 `STALE`，不会把遗留 `RUNNING` 文本当作真实存活服务。

### 6. 启动 Monitor

先确认 Kernel 已初始化，然后运行：

```text
npm run monitor:start
```

打开 `http://127.0.0.1:4319/`。Monitor 可以把当前人工审批的选择写入本地 Orchestrator 命令队列；Orchestrator 才会验证、推进 workflow 并通知 Manager。Monitor 不执行 workflow、HR、restore 或 revert。

## Git 快照与回滚

Agent 每个 task/attempt 使用不同的 detached worktree，失败重试不复用旧 worktree。只有 Developer/Test 可以修改目标 Git；其他 Agent 必须形成 `NO_CHANGE`。成功结果只有在宿主验证以下条件后才会成为快照：

- output commit 存在且为完整 SHA；
- output commit 是 input commit 的后代；
- output commit 等于 worktree HEAD；
- worktree 没有未提交修改；
- 修改清单由宿主 Git diff 计算。

Agent 崩溃、超时或遗留脏工作区时，宿主创建 `FAILED_RECOVERY` commit，不推进候选版本。

```text
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --run-id RUN-...
node scripts/orchestrator-cli.mjs snapshot-show --project-root . --snapshot-id SNP-...
node scripts/orchestrator-cli.mjs snapshot-diff --project-root . --snapshot-id SNP-...
node scripts/orchestrator-cli.mjs snapshot-restore --project-root . --snapshot-id SNP-...
node scripts/orchestrator-cli.mjs snapshot-revert --project-root . --snapshot-id SNP-... --confirm SNP-...
```

`restore` 创建新的 `openclaw/restore/*` 分支和 worktree，不改当前分支。`revert` 只接受当前 HEAD 的祖先 snapshot，创建反向 commit并要求精确确认；冲突时停止。系统不提供 `reset --hard` 回滚。

Git 与 SQLite 不做跨资源分布式事务。snapshot 索引失败会撤销本次 hidden ref，Restore 索引失败会清理新分支/worktree；Revert 已产生但索引失败时保留 commit 并返回 SHA 供人工对账，不自动改写历史。

## HR Agent

HR 默认只手动运行。它按 Agent Session 分批读取：

- assistant thinking/reasoning 记录；
- 最后一条 assistant 输出；
- 宿主验证的 Git 修改摘要和 patch。

它还接收最小任务边界（角色、step、目标、rationale、mutation policy），不会接收用户消息全文、system prompt、工具参数、工具输出或凭据。二进制文件只提供变更摘要/stat，不内联 binary patch。首版只检查：越权、边界不清晰、猜测/模糊结果。

手动审查：

```text
node scripts/orchestrator-cli.mjs hr-review --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs hr-review --project-root . --task-id TASK-...
node scripts/orchestrator-cli.mjs hr-review --project-root . --date 2026-08-21
node scripts/orchestrator-cli.mjs hr-run-pending --project-root .
```

`hr-review` 默认入队后立即执行；加 `--enqueue-only true` 只入队。

### 安全暂停工作流

在 Monitor 中，运行中的 workflow 可选择“暂停本轮”；暂停请求由 Orchestrator 消费后将 workflow 置为 `HOLD`。已经运行的 Agent 不会被中断，其结果仍会保存，但不会派发下一步骤或继续自动重试。`HOLD` 状态可在 Monitor 选择“恢复流程”，按当前已保存的任务状态继续。

Manager 也可在用户任何时点明确要求暂停或恢复后，通过受限的 `manager-control orchestrator-control` 动作提交同一控制请求；Manager 不得自行暂停，也不得承诺立即中断正在执行的 Agent。

日期必须是有效的 `YYYY-MM-DD`，按 UTC 匹配 snapshot 创建日期。同一 `snapshot + Agent Session` 在 manual/task/daily 之间共享去重键。

自动接口通过 `OPENCLAW_HR_AUTO_MODE` 控制：

- `off`：默认，只手动；
- `task`：任务进入终态后自动排队并由 Orchestrator 服务运行；
- `daily`：允许外部调度器调用 `hr-review-daily --date YYYY-MM-DD`；
- `both`：同时启用 task 和 daily。

本项目不自动创建系统计划任务。daily 命令适合由 cron、systemd timer 或 Windows Task Scheduler 调用：

```text
node scripts/orchestrator-cli.mjs hr-review-daily --project-root . --date 2026-08-21
```

HR 必须返回结构化 JSON findings，category 只能是上述三类，且每项必须包含 severity、证据定位、最短脱敏摘录、解释和建议。非法输出只把 HR job 标为 `FAILED`，不会修改原 workflow/task。Monitor 只展示校验后的 findings，不开放 HR 原始 Session。

## 状态、请求和审批

Manager 请求必须符合 `contracts/manager-request.schema.json`，并绑定原始 `manager_session_id` 和 `manager_session_key`。新项目由受控 `manager-control` 自动创建并以 `project_ref` 传递，用户无需预先创建目录、初始化 Git 或提供绝对路径；入口从受保护的 runtime 安装位置定位项目登记表，且 `project_ref` 只能用于登记它的 workflow。Orchestrator 校验并冻结路线，Worker 不能写 Kernel、派发其他 Agent 或修改审批。

常用只读命令：

```text
node scripts/orchestrator-cli.mjs status --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs kernel-status --project-root .
```

只读命令不会创建缺失的 Kernel。所有写命令与正在运行的前台 Orchestrator 互斥；冲突返回 `WORKFLOW_LOCK_CONFLICT`。停止命令只写服务控制文件，因此仍可在前台服务持锁时使用。

通知重试由 Orchestrator CLI 执行：

```text
node scripts/orchestrator-cli.mjs retry-notifications --project-root .
```

当 workflow 显示 `WAITING_HUMAN` 时，Monitor 会显示当前审批的真实选项。点击后仅显示“已排队”；前台 Orchestrator 在下一个轮询周期写入最终审批结果，并向原 Manager Session 发送通知。Manager 也可通过受限的 `manager-control orchestrator-status` 读取完整 pending `decision_id`，并通过 `orchestrator-approve` 创建绑定当前 Session 的 DECISION request；两者都不会直接写 Kernel。若用户只说明“abort 后重新发起”而未提供 workflow ID，Manager 先读取安装器生成的受控入口记录，再以当前 session key 调用只读 `orchestrator-current-status` 获取同一会话最近 workflow 的真实 ID、原需求和项目引用；该动作不会读取其它 session 的 workflow。

## 备份和恢复

Kernel 备份前先停止 Orchestrator，让数据库连接关闭并完成 WAL 收敛，然后复制：

```text
runtime/control/kernel.db
```

Git 快照内容位于目标项目自己的 `.git` object database 和 `refs/openclaw/snapshots/*`；只备份 SQLite 不能恢复代码。服务器备份必须同时覆盖目标 Git 仓库和 `work/`。

不要把旧 PostgreSQL 数据导入新库。需要重新开始时，停止 Orchestrator，确认目标路径是 `runtime/control/kernel.db` 后，由运维人员备份或移走该文件，再重新执行 `npm run kernel:schema`。

## 验证

```text
npm test
```

也可分别运行：

```text
npm run test:kernel
npm run test:orchestrator
npm run test:hr
npm run test:monitor
npm run test:runtime-bundle
```

Kernel 测试全部使用临时 SQLite，不需要外部数据库，也不应因缺少数据库而跳过。

### Agent JSON 生成与清洗测试

主矩阵排除使用 Docker sandbox 的 `test-agent`，覆盖其余 17 个 Agent Schema
场景（510 个逻辑测试）：

```text
npm run agent-json:matrix -- --run-id schema-matrix-<YYYYMMDD-HHMM> --concurrency 1 --timeout-seconds 120
```

结果写入 `artifacts/agent-json-workflow/<run-id>/`。`test-agent` 单独运行，
便于将 Docker sandbox 启动问题与 JSON 输出质量分开统计（60 个逻辑测试）：

```text
npm run agent-json:test-agent -- --run-id test-agent-matrix-<YYYYMMDD-HHMM> --concurrency 1 --timeout-seconds 120
```

结果写入 `artifacts/agent-json-workflow-test-agent/<run-id>/`。运行专用测试前，
确认 Docker Desktop Linux Engine 已启动且测试镜像可访问。

生产环境对齐矩阵是新增的独立比较测试：它不改动上述原始自由生成样例，而是对宿主实际
提供的哈希、提交号、归档快照和审计记录传入固定夹具，并要求 Agent 原样复制。它覆盖全部
8 个此前出现 JSON 错误的 Schema 场景，共 240 个逻辑测试（每场景 3 个样例 × 每样例 10 次），
包含 `test-agent`：

```text
npm run agent-json:production-aligned -- --run-id production-aligned-matrix-20260826-1600 --concurrency 1 --timeout-seconds 120
```

结果写入 `artifacts/agent-json-workflow-production-aligned/<run-id>/`。这是仅测 JSON 输出与
修复链路的矩阵；如本机未启用 Docker sandbox，请先按当前测试策略临时关闭 `test-agent`
sandbox，完成后再恢复，避免把启动失败混入 JSON 质量统计。

安装 dry-run 与验证：

```text
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
bash scripts/install.sh --runtime-root runtime
bash scripts/validate-install.sh --runtime-root runtime
```

## Agent 安全重装

只有普通更新不能恢复、注册状态或受管理 runtime 损坏时，才使用 Windows 安全重装。它是 Windows-only；先手动停止 OpenClaw Gateway 并显式确认后，再执行：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

当前没有等价的 Bash 重装脚本；Linux 使用普通 `install.sh --apply --yes` 更新，无法恢复时按安装验证输出人工处理。不要记录或调用不存在的 Linux/Python/Node 重装命令。
