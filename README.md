# openclaw-sdlc-multi-agent

在**已部署的 OpenClaw**（本机验证版本 `2026.7.1-2`）之上，使用 OpenClaw **原生多 Agent、独立 workspace、原生跨 Agent 会话调度、文件工具、Shell 工具和本地 Git 工具**，实现从需求到"运维前交付"的软件开发生命周期（SDLC）流程。

> **本项目没有 Python 控制平面，也没有常驻编排服务。** `manager-agent` 仍通过 OpenClaw 原生工具编排；按需运行的 Node.js Control Kernel 使用内置 SQLite 原子保存状态，但不调用模型、不调度 Agent。安装脚本（PowerShell / Bash）仅在安装与配置阶段使用。

## 这是什么

项目内置 7 个在 OpenClaw 中真实注册、彼此隔离的原生 Agent，并通过 package catalog 支持后续接入生成 Agent：

| Agent | 角色 |
|-------|------|
| `manager-agent` | 唯一工作流总控；管理状态、上下文、规则、Gate、审批、Git 合并；按 package capability 调度已激活 Agent |
| `requirement-agent` | 需求分析、验收标准、追踪关系 |
| `architect-agent` | 架构、接口、数据模型、威胁模型、测试策略、开发任务 |
| `developer-agent` | 生产代码实现（真实本地 Git commit） |
| `review-agent` | 独立代码/测试审查（默认只读，证据驱动） |
| `test-agent` | 补充并**真实执行**测试（无沙箱，`UNSANDBOXED_LOCAL`） |
| `release-agent` | 运维前发布候选验证（`GO`/`NO_GO`/`HOLD`，不部署） |

## 关键边界（务必先读）

- **单一状态权威。** v2 workflow/task/dispatch 当前状态只存在于 `<runtime>/control/control.db`；`runtime/control/v2/**` 是只读派生投影。见 [docs/architecture.md](docs/architecture.md)。
- **外部副作用可对账。** `sessions_spawn` 仍由 manager 调用；SQLite 先保存 intent/outbox，真实 session 返回后再写 receipt，不伪装跨系统原子事务。
- **测试阶段无 sandbox。** 本阶段 `test-agent` 在其被分配的本地 Git worktree 中**直接**执行测试，记录 `isolation_mode=UNSANDBOXED_LOCAL`。这是**当前阶段已知的安全限制**，不是"完全隔离"。见 [docs/unsandboxed-test-policy.md](docs/unsandboxed-test-policy.md) 与 [docs/threat-model.md](docs/threat-model.md)。
- **仅到"运维前交付"。** 不做真实部署、远程发布、CI/CD 接入、服务启停、生产迁移执行、生产凭证配置、监控告警。`release-agent` 的 `GO` 仅表示"具备移交后续运维/部署阶段的条件"。
- **仅本地 Git。** 不连接任何远程仓库；不 push/pull/fetch。
- **代码由 developer 实现。** manager 只能编排和验证；HTML、CSS、JavaScript、生产代码与构建配置必须通过正式 `developer-agent` task 在独立 worktree 中修改。大型前端按骨架、样式、组件、交互、验证拆分为有依赖关系的任务，避免单次生成完整大文件而触发模型输出截断。
- **绝对路径。** 所有 workspace、agentDir、worktree、artifact、任务输入输出路径均为规范化绝对路径，绝不依赖当前工作目录（即使从 `C:\Windows\System32` 启动）。
- **内置 Agent 只读。** 生成、更新和删除能力只能操作 `agents/packages/generated/`；内置 7 个 Agent 的源 workspace 不能被组件工具修改或删除。
- **生成组件必须审批。** 新 Agent/Skill 在构建、激活和删除前分别绑定用户审批；新 Agent 默认未注册、未激活、无 binding、不能派生子 Agent。

## 前置条件

- 已安装并可运行 OpenClaw（`openclaw --version` 正常）。本机验证：`2026.7.1-2 (0790d9f)`。
- Node.js 22.5+ 与 npm（推荐 Node.js 24；Control Kernel 使用内置 `node:sqlite`，Schema 校验使用 Ajv / ajv-formats）。
- Git（本机验证：`2.51.2.windows.1`）。
- PowerShell 7（Windows 主目标，本机验证：`7.6.4`）**或** Bash（本机验证：GNU bash 5.2.37）。
- Bash 实现需要现成的 `jq` 读取 package JSON；脚本不会自动安装它。

安装脚本**不会**自动安装任何依赖、不联网、不修改系统服务、不删除你已有的 OpenClaw Agent 或配置。

## Control Kernel v2 与 Runtime Guard

新 workflow 默认使用 `scripts/control-kernel.mjs`。SQLite 是唯一当前状态源；workflow state、不可变哈希事件、幂等 command result 与 projection outbox 同事务提交。`phase + condition + outcome` 分离流程阶段、暂停和终态，`active_workflows` SQL view 自动排除终态。

```bash
# 初始化数据库；提交一个版本化动作命令
node scripts/control-kernel.mjs init --project-root /abs/project --db /abs/runtime/control/control.db
node scripts/control-kernel.mjs apply --project-root /abs/project --db /abs/runtime/control/control.db --command-file /abs/command.json

# 生成只读投影、审计、确定性恢复
node scripts/control-kernel.mjs project --project-root /abs/project --db /abs/runtime/control/control.db --runtime-root /abs/runtime
node scripts/control-kernel.mjs audit --project-root /abs/project --db /abs/runtime/control/control.db --runtime-root /abs/runtime --projections true
node scripts/control-kernel.mjs recover --project-root /abs/project --db /abs/runtime/control/control.db --runtime-root /abs/runtime
```

Task/dispatch/result 依次使用 `task-register`、`task-validate`、`dispatch-prepare`、OpenClaw `sessions_spawn`、`dispatch-receipt` 和 `result-ingest`。`dispatch-outbox` 的 PENDING 项必须先按 session key 查询原 session；不得直接重复 spawn。只有 result 与 task 固定的全部必需 JSON/JSONL 验证通过，task 才能进入 `COMPLETED`。完整命令见 [Control Kernel v2](docs/control-kernel-v2.md)。

Control Kernel 不取代 Runtime Guard：Guard 继续校验 artifact、Gate、审批、Git candidate 与遗留 v1。旧 `commit-transition` / 可写 `active-workflows.json` 流程只保留给遗留 v1，不得用于新 workflow。

首次使用前安装依赖：

```bash
npm install
```

### 卸载并重新安装项目 Agent（Windows）

当源码 workspace 规则更新、或现有 runtime 缺少 bundle manifest 时，使用受限重装脚本同步**当前已安装**的项目 Agent。它仅处理 workspace/agentDir 与本项目 manifest 完全匹配的 Agent；未安装的 package（例如 `dialogue-agent`）不会被顺带注册。脚本会先备份 OpenClaw 配置及这些 Agent 的 runtime workspace/state，保留已有的每 Agent 模型路由，随后删除、重建、更新 `agents.list` 并校验 runtime bundle。

本仓库修改 `agents/*/workspace/` 下的规则后，也必须执行该同步流程；否则运行中的 Agent 仍使用旧 workspace 规则。

```powershell
# 先只查看将处理哪些 Agent
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime

# 执行卸载、重新安装、配置与 runtime 同步
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -RuntimeRoot runtime
```

### Runtime Guard（artifact/Gate 与遗留 v1）

```bash
# 校验 Guard 的 contracts、状态机与受映射模板
node scripts/runtime-guard.mjs self-check --project-root /abs/path/openclaw-sdlc-multi-agent

# 在派发、合并、阶段推进、恢复或完成声明前后校验一个 workflow
node scripts/runtime-guard.mjs check-workflow \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid>

# 写入 TASK_DISPATCHED 事件前校验一个完整任务包
node scripts/runtime-guard.mjs check-task-package \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid> \
  --task-id TASK-<uuid> \
  --task-file /abs/path/openclaw-runtime/control/workflows/WF-<uuid>/tasks/TASK-<uuid>.json

# 用 CAS + 事务日志一次提交事件、workflow、active index，并可选提交任务指针
node scripts/runtime-guard.mjs commit-transition \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid> \
  --expected-revision 7 \
  --event /abs/path/event-draft.json \
  --next-workflow /abs/path/next-workflow.json \
  --next-active /abs/path/next-active-workflows.json \
  [--next-task /abs/path/next-task.json]

# 崩溃后显式滚动完成 PREPARED / APPLYING 事务
node scripts/runtime-guard.mjs recover-transactions \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid>

# spawn 前创建幂等 dispatch intent；spawn 后再记录真实 session receipt
node scripts/runtime-guard.mjs prepare-dispatch \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid> --task-id TASK-<uuid> --run-id RUN-<uuid> \
  --task-file /abs/path/task.json --agent-id developer-agent --attempt 1 \
  --session-key agent:developer-agent:WF-...:TASK-...:RUN-...

node scripts/runtime-guard.mjs reconcile-dispatch \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  --workflow-id WF-<uuid> [--dispatch-id DSP-<uuid>]

# 恢复入口：未指定 workflow ID 时仅允许恰好一个活动工作流
node scripts/runtime-guard.mjs recovery-check \
  --project-root /abs/path/openclaw-sdlc-multi-agent \
  --runtime-root /abs/path/openclaw-runtime \
  [--workflow-id WF-<uuid>]
```

Guard 使用 Ajv / ajv-formats 作为本地 JSON Schema validator。Guard 失败会以非零退出码和 `effective_status=HOLD` 阻止推进。上方 `commit-transition`、文件型事务日志和 v1 dispatch ledger 说明只适用于遗留协议；v2 的 workflow/task/dispatch/result 状态必须通过 Control Kernel。Guard 仍校验任务 artifact、上下文 SHA-256、审批、Gate、review/release authority、Git candidate 和遗留事件链。

`check-task-package` 是派发前必经检查：它要求完整 input package、canonical artifact/worktree 路径与 manifest SHA-256 均正确，才允许写入派发事件。每份任务还必须在 `structured_outputs[]` 声明跨 Agent JSON/JSONL 的路径、受信任 Schema、格式和产出者；完成任务时 Guard 再次校验这些文件。`QUARANTINED` 是不可恢复的审计终态，必须保留 `quarantine-report.md` 和 `final-report.md`，且不得重写历史 input、event 或 artifact。

4 个已发现的不一致 v1 workflow 已通过 `MIG-legacy-quarantine-20260805` 做取证归档并导入 v2 隔离 tombstone；没有补造缺失事件，也没有信任旧 candidate。流程与报告格式见 [legacy v1 forensic quarantine](docs/legacy-v1-migration.md)。

所有 JSON / JSONL 输出错误必须记录到 `raw-logs/json-validation-errors.jsonl` 或 workflow 级 `validation-errors.jsonl`，记录格式见 `contracts/json-validation-error.schema.json`。首次 JSON 校验失败只允许一次 JSON-only retry：只重新生成失败的 JSON / JSONL，不重新完整分析任务。

模型、Responses/Chat 路由和 JSON 回复恢复策略见 [docs/model-routing.md](docs/model-routing.md) 与 [docs/llm-json-recovery.md](docs/llm-json-recovery.md)。JSON/JSONL 回复只做保守包装清洗，之后由 Ajv 校验；空输出、截断、enum/type 违规与 schema drift 共用首次调用之外最多 2 次重写预算。有有效工具调用的无文本中间响应不算空输出。

### Manager 模型与变更状态

`manager-agent` 的默认模型为 `deepseek/deepseek-v4-pro`。如果 TUI 显示的模型与此不一致，应先执行 `openclaw models status --agent manager-agent --check`；当默认项正确而 TUI 仍显示其他模型时，检查并清除 Manager 父会话的会话级 `providerOverride` / `modelOverride`，然后重新启动 TUI。不要把模型凭据或完整认证输出写入项目文档、日志或 Issue。

每一项项目改动都必须在用户完成检查/验收后同步更新 [CHANGELOG.md](CHANGELOG.md)、本 README 和 [docs/current-progress-assessment.md](docs/current-progress-assessment.md)：Changelog 记录实际改动、原因、效果和验证；README 记录用户可见的操作或配置变化；完成度评估记录状态、证据、风险和未完成项。未完成用户检查的工作不得标记为已验证或已完成。

Manager 保持 `deepseek/deepseek-v4-pro` 和 `thinking=high`。其模型窗口为 200k token，项目软预算为 80%（160k token），配置见 `config/manager-session-policy.json`。达到预算后必须由新 Manager 会话结合 `recovery-check` 和 `context-summary.md` 恢复；不要通过增大 `contextTokens`、复制完整聊天记录或把完整工具日志放入 prompt 规避预算。

7 个 Agent 统一使用 DeepSeek V4 Pro + Chat Completions API，模型引用为 `deepseek/deepseek-v4-pro`。配置样例见 `config/agent-models.deepseek-routing.example.json`。

### 可观测性与监督计划状态

实时看板和自动监督目前仍是待实施计划，不是已上线功能。修订后的方案使用宿主机原生
Node.js Supervisor Core 读取 Control Kernel 权威状态、采集安全遥测、执行健康判定和
Watchdog；图形界面使用可直接打开的静态 `monitor/ui/index.html`，不需要前端安装或构建。
关闭或未打开 HTML 页面不会停止监督核心。

只读状态、活动采集和 Watchdog 影子模式可以先实施；自动 NUDGE、manager 唤醒和受控 retry
必须等待 Manager 编排加固中对应的身份校验、不可绕过派发、原子写入及中断恢复验收通过。
完整节点职责、交互信息、阶段门槛与验收标准见
[可观测性与监督实施计划](docs/plan/2026-08-04-agent-observability-monitor.md)。

## Agent LLM JSON 合约测试

本地完整回归入口（Runtime Guard、离线 LLM harness、Bash/PowerShell 安装验证）：

```bash
npm test
```

离线检查只验证测试规划、单 Gateway 客户端调用状态机和失败包完整性，不调用模型：

```bash
npm run test:agent-json:offline
```

### 单 Schema 的轻量 Agent 通信测试

`scripts/agent-llm-contract-tests/` 为 `contracts/` 下的每一份 JSON Schema 提供对应入口。脚本只经 OpenClaw Gateway 向已注册 Agent 发送消息，**不直接调用 LLM API、不调用 Agent 工具**；每次运行严格发送 10 次独立请求，并由脚本使用 Runtime Guard + Ajv 校验返回的 JSON/JSONL。

```powershell
# 测试 developer-agent 返回的 result.json 契约：固定 10 次 Agent 调用
node scripts/agent-llm-contract-tests/run-result.mjs

# 测试 manager-agent 返回的 workflow 契约：固定 10 次 Agent 调用
node scripts/agent-llm-contract-tests/run-workflow.mjs

# 通用入口：将 schema 文件名替换为 contracts/ 下的任一 *.schema.json
npm run agent-contract:test -- --schema result.schema.json
```

运行结果会写入被 Git 忽略的 `artifacts/agent-llm-contract-tests/<run-id>/<schema>/`。`summary.json` 记录 10 次调用的通过/失败数；`errors.json` 是完整失败包，包含原始 Agent 回复、内容哈希、清洗记录、错误分类和 Ajv 诊断；`failures/call-<n>.json` 则便于逐条检查。错误分类覆盖截断、schema drift、enum/type 违规、JSON 格式错误、空输出、无文本回复和 Agent 通信错误。完整入口清单见 `scripts/agent-llm-contract-tests/README.md`。

全量真实测试通过现有 OpenClaw Gateway 的一个持久客户端连接调用已注册角色；每个 Agent 通信契约使用 5 条不同需求，默认独立重复 2 轮。Control Kernel 内部契约只由 Runtime Guard 编译，不委托 LLM 生成。测试仅评估 Agent 的最终 LLM 回复，不调用 Agent 工具、不要求 Agent 写文件，也不会为每个用例启动 OpenClaw CLI。回复会先保守清洗、再由 Guard 校验；首次调用之外最多进行两次分类重写。每次失败都保留原始回复、清洗元数据、Guard 报告和提示，并由中文 `report.md` 汇总在被 Git 忽略的 `artifacts/agent-llm-json/<run-id>/`。

```bash
npm run agent-json:real

# 指定可追溯的运行 ID
npm run agent-json:real -- --run-id <run-id>

# 默认顺序执行以复用一个 Gateway 客户端连接；需要时可显式调整并发数
npm run agent-json:real -- --concurrency 1

# 调整每个差异化案例的独立重复次数（默认 2）
npm run agent-json:real -- --repetitions 2

# 调试单个场景（场景名见 report.md / scripts/agent-json-harness/llm-scenarios.mjs）
npm run agent-json:real -- --scenario result --timeout-seconds 600
```

## 快速开始（Windows / PowerShell 7）

安装脚本默认只做 **dry-run**，不会修改你的 OpenClaw 配置。可从任意目录调用——脚本会相对自身位置解析项目根目录并规范化为绝对路径。

```powershell
# 1) 预演（默认 dry-run，不写入任何 OpenClaw 配置）
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\install.ps1" `
  -RuntimeRoot "d:\MicroConnect\project\openclaw-multi-agent\runtime"

# 2) 静态验证（不改配置）
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\validate-install.ps1"

# 3) 同步所有 register=true 的 Agent package（先自动备份，再校验）
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\install.ps1" `
  -RuntimeRoot "d:\MicroConnect\project\openclaw-multi-agent\runtime" `
  -Apply -Yes
```

即使从 System32 调用，路径仍指向本项目：

```powershell
Set-Location "C:\Windows\System32"
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\install.ps1" `
  -RuntimeRoot "runtime"    # 相对值相对“项目根目录”解析，而非当前 System32
```

## 快速开始（Linux / macOS / Git Bash）

```bash
# 预演
bash scripts/install.sh \
  --runtime-root /abs/path/openclaw-sdlc-multi-agent/runtime

# 静态验证
bash scripts/validate-install.sh

# 真正注册（修改配置，先备份）
bash scripts/install.sh \
  --runtime-root runtime --apply --yes
```

### 当前 Linux 服务器的完整部署步骤

下面的命令只针对当前服务器，已使用本项目在服务器上的真实绝对路径。原有的跨平台示例保留在上方；在这台服务器上部署时，请优先按照本节从上到下执行。

当前服务器已核对的环境基线：

| 项目 | 当前值 |
|------|--------|
| 操作系统 | Ubuntu Linux，x86_64 |
| 项目目录 | `/home/ubuntu/microconnect/openclaw-multi-agent` |
| Runtime 目录 | `/home/ubuntu/microconnect/openclaw-multi-agent/runtime` |
| OpenClaw 配置 | `/home/ubuntu/.openclaw/openclaw.json` |
| OpenClaw | `2026.7.1 (2d2ddc4)` |
| Bash | `5.2.21` |
| jq | `1.7` |
| Git | `2.43.0` |
| Node.js | `22.23.1` |

> 项目原始兼容性基线是 OpenClaw `2026.7.1-2`，当前服务器运行的是 `2026.7.1`。当前版本的 `agents add`、`config set`、`config validate` 和 Gateway 接口已核对存在，但正式写配置前仍必须完成下面的静态验证和 dry-run。

#### 1. 设置固定路径并检查环境

```bash
PROJECT_ROOT=/home/ubuntu/microconnect/openclaw-multi-agent
RUNTIME_ROOT=/home/ubuntu/microconnect/openclaw-multi-agent/runtime

cd "$PROJECT_ROOT"

bash --version | head -n 1
jq --version
git --version
openclaw --version
openclaw config file
openclaw config validate --json
openclaw gateway status
openclaw models status --agent main --check
```

预期结果：

- 所有命令均能找到，且 `openclaw config validate --json` 返回 `"valid": true`。
- `openclaw gateway status` 显示 Gateway 正在运行且 connectivity probe 正常。
- `openclaw models status --agent main --check` 退出码为 `0`。该命令可能显示经过掩码处理的认证摘要，不要把完整输出复制到日志、Issue 或聊天中。

当前服务器的 Gateway 状态会提示 systemd service 使用了 NVM/包管理器路径。这是现有服务配置警告；只要 runtime 为 `running` 且 connectivity probe 为 `ok`，它不阻塞本项目部署。不要在本部署流程中运行 `openclaw doctor --repair` 或 `openclaw doctor --fix`。

如果 Gateway 未运行，先检查当前 systemd user service；不要运行会自动修改配置的修复命令：

```bash
systemctl --user status openclaw-gateway.service --no-pager
journalctl --user -u openclaw-gateway.service -n 100 --no-pager
```

#### 2. 执行静态验证和安装预演

安装前先运行不依赖已注册 `manager-agent` 的静态检查：

```bash
bash "$PROJECT_ROOT/scripts/validate-install.sh" --skip-openclaw
```

然后执行安装 dry-run。该命令不会修改 OpenClaw 配置，但会在 `artifacts/install-dryrun/` 生成计划清单：

```bash
bash "$PROJECT_ROOT/scripts/install.sh" \
  --runtime-root "$RUNTIME_ROOT"

jq '{mode, openclaw_version, config_file, runtime_root_abs, agents}' \
  "$PROJECT_ROOT/artifacts/install-dryrun/install-manifest.dryrun.json"
```

确认清单满足以下条件后再继续：

- `mode` 为 `DRYRUN`。
- `config_file` 为 `~/.openclaw/openclaw.json`。这是当前 OpenClaw CLI 的显示形式，实际绝对路径是 `/home/ubuntu/.openclaw/openclaw.json`。
- `runtime_root_abs` 为 `/home/ubuntu/microconnect/openclaw-multi-agent/runtime`。
- 清单包含 7 个内置 Agent，且所有 `workspace_abs`、`agentDir_abs` 都位于上述 Runtime 目录中。
- 没有“同名 Agent 已存在且 workspace 不同”的冲突提示。

#### 3. 正式注册 Agent

当前服务器的 `openclaw config file` 返回带 `~` 的路径。当前 Bash 安装脚本不会展开这个字符串，因此可能跳过脚本内置的配置备份。正式安装前必须先用绝对路径手动备份：

```bash
CONFIG_FILE=/home/ubuntu/.openclaw/openclaw.json
SNAPSHOT_DIR="$RUNTIME_ROOT/control/config-snapshots"
MANUAL_SNAPSHOT="$SNAPSHOT_DIR/openclaw.json.$(date +%Y%m%d-%H%M%S).pre-install.manual.bak"

mkdir -p "$SNAPSHOT_DIR"
test -f "$CONFIG_FILE"
jq empty "$CONFIG_FILE"
cp -- "$CONFIG_FILE" "$MANUAL_SNAPSHOT"
jq empty "$MANUAL_SNAPSHOT"
printf '手动配置快照：%s\n' "$MANUAL_SNAPSHOT"
```

保存终端打印的 `MANUAL_SNAPSHOT` 绝对路径，然后再正式注册：

```bash
bash "$PROJECT_ROOT/scripts/install.sh" \
  --runtime-root "$RUNTIME_ROOT" \
  --apply \
  --yes
```

项目脚本设计上会把当前 OpenClaw 配置备份到：

```text
/home/ubuntu/microconnect/openclaw-multi-agent/runtime/control/config-snapshots/
```

但在当前 OpenClaw `2026.7.1` 上，安装输出可能提示未找到 `~/.openclaw/openclaw.json` 并跳过脚本内置备份。因此本服务器必须以前一步生成的 `*.pre-install.manual.bak` 为可靠回滚点，不要只依赖安装脚本自动生成的快照。

本命令没有传入 `--set-manager-as-default` 或 `--manager-binding`，因此不会主动把 `manager-agent` 设为默认 Agent，也不会改动现有渠道 binding。当前服务器原有的 `main` Agent 应继续保持默认。

#### 4. 验证安装结果

```bash
bash "$PROJECT_ROOT/scripts/validate-install.sh"
openclaw config validate --json

openclaw agents list --json | jq \
  'map({id, workspace, agentDir, model, isDefault})'

openclaw config get agents.list --json | jq \
  '.[] | select(.id == "manager-agent") | {id, subagents}'

openclaw config get agents.list --json | jq \
  '.[] | select(.id == "test-agent") | {id, sandbox}'

openclaw models status --agent manager-agent --check
```

再执行以下断言；命令没有输出且退出码为 `0` 表示通过：

```bash
openclaw agents list --json | jq -e '
  ([
    "manager-agent",
    "requirement-agent",
    "architect-agent",
    "developer-agent",
    "review-agent",
    "test-agent",
    "release-agent"
  ] - map(.id) | length) == 0
' >/dev/null

openclaw agents list --json | jq -e \
  'any(.[]; .id == "main" and .isDefault == true)' >/dev/null
```

安装成功应同时满足：

- 7 个项目 Agent 均已注册。
- `manager-agent.subagents.allowAgents` 包含其余 6 个工作 Agent，且 `requireAgentId=true`、`delegationMode=prefer`。
- 其余工作 Agent 的 `subagents.allowAgents` 为空。
- `test-agent.sandbox.mode` 为 `off`，即当前测试阶段是 `UNSANDBOXED_LOCAL`，不是完全隔离。
- 原有 `main` Agent 的 `isDefault` 仍为 `true`。
- `openclaw models status --agent manager-agent --check` 和 `openclaw config validate --json` 均成功。

#### 5. 最小调用测试

不改变默认 Agent，显式调用 `manager-agent`：

```bash
openclaw agent \
  --agent manager-agent \
  --message "请只确认 manager-agent 已可用，不要创建工作流。" \
  --json
```

如果该命令返回模型或认证错误，先检查该 Agent 的模型状态，不要在 README、日志或 Issue 中粘贴密钥：

```bash
openclaw models status --agent manager-agent --check
openclaw models status --agent manager-agent --probe
```

如果静态验证、配置校验、7 个 Agent 注册、默认 Agent 检查和最小调用测试全部通过，则当前服务器的部署完成。

## 恢复 OpenClaw 配置

```powershell
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\restore-openclaw-config.ps1" `
  -SnapshotPath "<runtime>\control\config-snapshots\openclaw.json.<timestamp>.bak"
```

```bash
bash /abs/path/scripts/restore-openclaw-config.sh \
  --snapshot "<runtime>/control/config-snapshots/openclaw.json.<timestamp>.bak"
```

当前 OpenClaw `2026.7.1` 的 `openclaw config file` 返回 `~/.openclaw/openclaw.json`，而 Bash 恢复脚本不会展开带引号的 `~`。因此保留上方原始跨平台命令作为项目参考，但当前服务器请使用下面的绝对路径手动恢复流程。

先列出可恢复项：

```bash
RUNTIME_ROOT=/home/ubuntu/microconnect/openclaw-multi-agent/runtime

ls -1t "$RUNTIME_ROOT"/control/config-snapshots/*.bak
```

从列表中复制需要恢复的完整绝对路径，先校验快照，再备份当前配置并恢复：

```bash
CONFIG_FILE=/home/ubuntu/.openclaw/openclaw.json
SNAPSHOT="/home/ubuntu/microconnect/openclaw-multi-agent/runtime/control/config-snapshots/openclaw.json.<timestamp>.pre-install.manual.bak"
PRE_RESTORE="$RUNTIME_ROOT/control/config-snapshots/openclaw.json.$(date +%Y%m%d-%H%M%S).pre-restore.manual.bak"

mkdir -p "$RUNTIME_ROOT/control/config-snapshots"
test -f "$SNAPSHOT"
jq empty "$SNAPSHOT"
cp -- "$CONFIG_FILE" "$PRE_RESTORE"
cp -- "$SNAPSHOT" "$CONFIG_FILE"
openclaw config validate --json
systemctl --user restart openclaw-gateway.service
openclaw gateway status
```

只有 `openclaw config validate --json` 通过后才重启 Gateway。如果校验失败，不要重启；把 `PRE_RESTORE` 复制回 `/home/ubuntu/.openclaw/openclaw.json` 后重新校验。

恢复脚本只恢复你明确选择的快照，覆盖前会再次备份当前配置。**恢复配置 ≠ 删除 workspace**，两者是不同操作。

## 如何把需求交给 manager-agent

安装并注册后，在 OpenClaw 中与 `manager-agent` 对话（默认只有它直接与用户交流）。给它：

1. 你的原始需求（自然语言）。
2. 目标业务项目的**绝对路径**。

当前 Linux 服务器不修改默认 Agent，可通过 CLI 显式把需求交给 `manager-agent`：

```bash
openclaw agent \
  --agent manager-agent \
  --message "请处理以下需求：<你的需求>。目标业务项目绝对路径：/absolute/path/to/target-project" \
  --json
```

目标路径必须是待开发业务项目的真实绝对路径，不要填写本 README 中的占位符。若需要在后续命令中继续同一个会话，可为首次调用和后续调用传入相同的 `--session-key`。

`manager-agent` 会保存原始需求、规范化目标路径、探测 Git 状态、创建 `workflow.json`，然后按 SDLC 阶段调度其余 Agent。详见 [docs/workflow.md](docs/workflow.md) 与 [docs/manager-orchestration.md](docs/manager-orchestration.md)。

## Agent package 与生成组件

内置 Agent 由 `agents/packages/builtin/*.json` 描述，安装脚本不再维护固定 ID 数组。生成 Agent 位于 `agents/packages/generated/agents/<id>/`，生成 Skill 位于 `agents/packages/generated/skills/<slug>/`。

```powershell
# 查看和校验 catalog
pwsh -File scripts/manage-components.ps1 -Command List
pwsh -File scripts/manage-components.ps1 -Command Validate

# 预演 package 同步
pwsh -File scripts/install.ps1
```

上面的组件管理命令依赖 PowerShell 7；当前 Linux 服务器没有对应的 Bash 版 `manage-components.sh`。普通部署和内置 package 校验不需要执行这些 PowerShell 命令，可使用下面的 Linux 命令：

```bash
PROJECT_ROOT=/home/ubuntu/microconnect/openclaw-multi-agent

bash "$PROJECT_ROOT/scripts/validate-install.sh" --skip-openclaw
bash "$PROJECT_ROOT/scripts/install.sh" \
  --runtime-root "$PROJECT_ROOT/runtime"
```

如果确实要在当前服务器上运行 `manage-components.ps1` 的 `List`、`Validate`、生成或删除组件功能，需要先由管理员安装 PowerShell 7；本项目脚本不会自动安装该依赖。不要把上面的 Bash 校验命令理解为所有组件管理子命令的完整替代品。

Manager 只有在用户批准后才能调用 `NewAgent`；构建完成后还需第二次审批才能注册或激活。Skill 内容直接使用 OpenClaw bundled `skill-creator`，proposal/apply/reject/quarantine 使用原生 Skill Workshop，不在项目中重复实现 Skill Creator。完整协议见 [docs/component-management.md](docs/component-management.md)。本阶段不创建 MCP。

## manager-agent 如何恢复已中断的工作流

新的 manager 会话不依赖聊天历史。v2 先验证 runtime bundle，再运行 Control Kernel `audit`；数据库一致而投影缺失/漂移时运行 `recover`。随后查询 `active` 与 `dispatch-outbox`：多个活动 workflow 仍由用户选择，PENDING dispatch 必须按 session key 查询 OpenClaw 原 session 后对账。数据库事件/snapshot 不一致时进入 HOLD，不得从聊天或投影反向修复。遗留 v1 只允许 Runtime Guard 读取审计或使用取证迁移器隔离。

## 文档索引

- [docs/architecture.md](docs/architecture.md) — Control Kernel v2、outbox 与权威边界
- [docs/control-kernel-v2.md](docs/control-kernel-v2.md) — v2 命令、状态与恢复
- [docs/legacy-v1-migration.md](docs/legacy-v1-migration.md) — 遗留 v1 取证隔离
- [docs/native-openclaw-integration.md](docs/native-openclaw-integration.md) — 使用了哪些原生 CLI 与工具
- [docs/manager-orchestration.md](docs/manager-orchestration.md) — 原生调度算法
- [docs/context-and-rule-passing.md](docs/context-and-rule-passing.md) — 上下文包与规则快照
- [docs/workflow.md](docs/workflow.md) — SDLC 阶段
- [docs/agent-contracts.md](docs/agent-contracts.md) — 输入输出契约
- [docs/state-and-recovery.md](docs/state-and-recovery.md) — 状态与恢复背景（v2 以 Control Kernel 文档为准）
- [docs/git-worktree-strategy.md](docs/git-worktree-strategy.md) — 分支与 worktree
- [docs/evidence-and-claims.md](docs/evidence-and-claims.md) — 事实分级与命令日志
- [docs/human-approval.md](docs/human-approval.md) — 人工审批节点
- [docs/gate-checklists.md](docs/gate-checklists.md) — Gate 检查清单
- [docs/unsandboxed-test-policy.md](docs/unsandboxed-test-policy.md) — 无沙箱测试策略
- [docs/compatibility-report.md](docs/compatibility-report.md) — 实测 OpenClaw 版本与差异
- [docs/troubleshooting.md](docs/troubleshooting.md) — 排错
- [docs/threat-model.md](docs/threat-model.md) — 威胁模型
- [docs/component-management.md](docs/component-management.md) — Agent package、审批式生成、Skill Workshop 与删除边界
- [docs/model-routing.md](docs/model-routing.md) — Agent 模型路由、Responses/Chat 边界与空输出恢复
- [docs/plan/2026-08-04-agent-observability-monitor.md](docs/plan/2026-08-04-agent-observability-monitor.md) — 原生 Supervisor Core、静态 HTML 看板与监督闭环计划
- [docs/plan/2026-08-05-manager-orchestration-hardening.md](docs/plan/2026-08-05-manager-orchestration-hardening.md) — 自动监督前置的 Manager 编排加固计划

## 许可与安全

见 [SECURITY.md](SECURITY.md)。本项目不记录、不显示任何密钥/令牌/凭证。
