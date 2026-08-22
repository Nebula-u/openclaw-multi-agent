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
        └─ artifacts: runtime/artifacts/*

Read-only Monitor ── SQLite facts + redacted Sessions
```

边界：

- SQLite 只支持同一台机器上的本地磁盘，不得放在 SMB、NFS、云盘同步目录，也不得由多台服务器共享。
- 前台 Orchestrator、一次性写 CLI、schema 初始化和 HR runner 共用单写者锁；Monitor 与只读 CLI 使用 `query_only` 连接。
- Git 是代码版本、差异和回滚的唯一引擎；SQLite `snapshots` 只保存索引。
- 没有事件哈希链、数据库 revision CAS 或 artifact 内容寻址副本。
- 本版本从空 SQLite 开始，不迁移 PostgreSQL 或旧 StateGraph 历史数据。

详细说明见 [架构](docs/architecture.md)、[Git 快照](docs/git-worktree-strategy.md)、[HR 审查](docs/hr-review.md) 和 [监控](docs/monitoring.md)。

## 环境要求

- Node.js 22.13 或更高版本；项目使用内置 `node:sqlite`。
- Git。
- 已安装并可运行的 OpenClaw。
- Windows PowerShell 7，或 Linux Bash。

不需要 PostgreSQL、Redis、Docker 数据库容器或额外 SQLite npm 包。

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

打开 `http://127.0.0.1:4319/`。Monitor 不执行 workflow、HR、restore 或 revert。

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

Manager 请求必须符合 `contracts/manager-request.schema.json`，并绑定原始 `manager_session_id` 和 `manager_session_key`。Orchestrator 校验并冻结路线，Worker 不能写 Kernel、派发其他 Agent 或修改审批。

常用只读命令：

```text
node scripts/orchestrator-cli.mjs status --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs kernel-status --project-root .
```

只读命令不会创建缺失的 Kernel。所有写命令与正在运行的前台 Orchestrator 互斥；冲突返回 `WORKFLOW_LOCK_CONFLICT`。停止命令只写服务控制文件，因此仍可在前台服务持锁时使用。

通知重试由 Orchestrator CLI 执行；Monitor 保持只读：

```text
node scripts/orchestrator-cli.mjs retry-notifications --project-root .
```

## 备份和恢复

Kernel 备份前先停止 Orchestrator，让数据库连接关闭并完成 WAL 收敛，然后复制：

```text
runtime/control/kernel.db
```

Git 快照内容位于目标项目自己的 `.git` object database 和 `refs/openclaw/snapshots/*`；只备份 SQLite 不能恢复代码。服务器备份必须同时覆盖目标 Git 仓库和 `runtime/artifacts/`。

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

安装 dry-run 与验证：

```text
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
bash scripts/install.sh --runtime-root runtime
bash scripts/validate-install.sh --runtime-root runtime
```

## Agent 安全重装

只有普通更新不能恢复、注册状态或受管理 runtime 损坏时，才使用 Windows 安全重装。先手动停止 OpenClaw Gateway，然后执行：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

当前没有等价的 Bash 重装脚本；Linux 使用普通 `install.sh --apply --yes` 更新，无法恢复时按安装验证输出人工处理。不要记录或调用不存在的 Linux/Python/Node 重装命令。
