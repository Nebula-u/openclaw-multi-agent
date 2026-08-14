# openclaw-multi-agent

本项目使用 LangGraph `StateGraph + checkpointer` 驱动本机多 Agent 软件交付流程。最新 checkpoint 是 workflow、路线、任务、审批、候选 commit 和事件链的唯一事实源；Manager、worker、launcher、日志和 monitor 都不能直接推进状态。

## 核心边界

```text
用户请求
  -> Manager 仅提出 route-plan
  -> 本地代码校验并生成路线确认审批
  -> 人工确认后冻结 route_hash / steps / approval_plan
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
- monitor 是 Node.js 只读后端，只查询最新 checkpoints 和本地 telemetry。

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

## 运行 Workflow

初始化本地 runtime/human capability：

```powershell
node scripts/workflow.mjs init --project-root .
```

请求文件示例：

```json
{
  "text": "实现功能并完成评审、测试和发布准备",
  "project_path_abs": "D:/absolute/path/to/target-repository"
}
```

创建并推进 workflow：

```powershell
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

## Node Monitor

```powershell
npm run monitor:start
# 或
pwsh -NoProfile -File scripts/start-monitor.ps1 -Port 4319
```

```bash
bash scripts/start-monitor.sh
```

打开 `monitor/ui/index.html`。后端默认监听 `127.0.0.1:4319`，提供 GET-only API、SSE、checkpoint audit、自动续跑、会话目录、artifact 观察与健康分类。部署说明见 [docs/monitoring.md](docs/monitoring.md)。项目不包含 Java、Servlet 或 Tomcat monitor 代理。

## 运行目录

```text
runtime/
  stategraph/checkpoints.db
  stategraph/test-sandbox-global.lock
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

也可分组执行：

```powershell
node --test tests/stategraph-*.test.mjs
node --test --test-concurrency=1 tests/monitor-*.test.mjs
node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
```

当前自动化测试覆盖 checkpoint 恢复、路线冻结、候选 commit、证据 SHA、JSON 恢复、sandbox lease 和 monitor。Docker daemon 未运行时，mock command-boundary 测试仍可执行，但不能视为真实容器 E2E。
