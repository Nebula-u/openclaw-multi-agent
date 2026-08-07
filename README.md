# openclaw-multi-agent

本项目使用 OpenClaw worker Agent 与本地 Orchestrator 完成受控的多 Agent 开发流程。

状态、派发、结果接收和重试由本地代码决定；Agent 只执行已分配任务、修改指定 worktree，并写入暂存结果。看板为只读，只显示任务阶段、状态、负责 Agent 和用户可见对话。

## 当前功能

- Control DB 是 workflow、task、run、dispatch、receipt 和 completion 的唯一事实源。
- 本地 Orchestrator 从已验证 task 固定派生目标 Agent、session 和派发回执；Agent 不可自行派发或改状态。
- Agent JSON/JSONL 只能写入 `<artifact_root>/.agent-raw/**`；本地代码统一清洗、Ajv 校验、原子发布最终文件。
- JSON 解析、路径安全或 Schema 校验失败时，本地代码保留原始暂存文件，并写入 `.orchestrator-ingest/*.failure.json` 和 `.orchestrator-ingest/validation-errors.jsonl`。
- Monitor 不提供写入、重试、催办或与 Agent 交互的入口；不展示思考、工具调用、session、路径和控制细节。

## 前置条件

- 已安装 OpenClaw，`openclaw --version` 可用。
- Node.js 22.5+、npm、Git。
- Windows 使用 PowerShell 7；Bash 安装脚本还需要 `jq`。

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

首次运行或 `runtime/control` 尚未初始化时执行一次：

```powershell
node scripts/orchestrator.mjs init --project-root .
```

该命令创建本地 capability；不要读取、复制或打印 capability 文件内容。

### 3. 启动只读看板

```powershell
npm run supervisor:start
```

另开浏览器打开 `monitor/ui/index.html`。默认 Supervisor API 为 `http://127.0.0.1:4319`。

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

## 更新已安装 Agent（Windows）

源码规则变更后，需要重新同步 runtime Agent。该脚本只处理 workspace 与 agentDir 和本项目 manifest 精确匹配的 7 个项目 Agent；不会处理 `main`、其他项目 Agent 或未注册的 `dialogue-agent`。

```powershell
# 先停止 Gateway，并查看计划
openclaw gateway stop
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime

# 备份 → 删除已验证 Agent/runtime → 重装 → 校验
pwsh -NoProfile -File scripts/reinstall-agents.ps1 `
  -GatewayStopped -Apply -Yes -RuntimeRoot runtime

# 启动并确认 Gateway
openclaw gateway start
openclaw gateway status
```

备份位于 `runtime/control/reinstall-backups/<timestamp>/`。普通 `install.ps1` 不会删除已有 Agent；重装脚本要求显式 `-GatewayStopped`，且路径不匹配即拒绝删除。

## 测试

```powershell
npm test
```

问题、已完成整改和仍需部署侧处理的风险见 [docs/problem](docs/problem/)。
