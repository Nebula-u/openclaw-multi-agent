# openclaw-sdlc-multi-agent

在**已部署的 OpenClaw**（本机验证版本 `2026.7.1-2`）之上，使用 OpenClaw **原生多 Agent、独立 workspace、原生跨 Agent 会话调度、文件工具、Shell 工具和本地 Git 工具**，实现从需求到"运维前交付"的软件开发生命周期（SDLC）流程。

> **本项目没有 Python 控制平面。** 日常工作流不启动任何后台服务、不执行本项目自建的编排脚本、不依赖 Python 运行时。全部编排由 `manager-agent` 依据固定文件协议 + OpenClaw 原生工具完成。安装脚本（PowerShell / Bash）**仅**在安装与配置阶段使用。

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

- **无 Python 控制平面。** 见 [docs/architecture.md](docs/architecture.md)。日常运行只依赖 OpenClaw 原生 Agent、原生工具、文件与本地 Git。
- **测试阶段无 sandbox。** 本阶段 `test-agent` 在其被分配的本地 Git worktree 中**直接**执行测试，记录 `isolation_mode=UNSANDBOXED_LOCAL`。这是**当前阶段已知的安全限制**，不是"完全隔离"。见 [docs/unsandboxed-test-policy.md](docs/unsandboxed-test-policy.md) 与 [docs/threat-model.md](docs/threat-model.md)。
- **仅到"运维前交付"。** 不做真实部署、远程发布、CI/CD 接入、服务启停、生产迁移执行、生产凭证配置、监控告警。`release-agent` 的 `GO` 仅表示"具备移交后续运维/部署阶段的条件"。
- **仅本地 Git。** 不连接任何远程仓库；不 push/pull/fetch。
- **绝对路径。** 所有 workspace、agentDir、worktree、artifact、任务输入输出路径均为规范化绝对路径，绝不依赖当前工作目录（即使从 `C:\Windows\System32` 启动）。
- **内置 Agent 只读。** 生成、更新和删除能力只能操作 `agents/packages/generated/`；内置 7 个 Agent 的源 workspace 不能被组件工具修改或删除。
- **生成组件必须审批。** 新 Agent/Skill 在构建、激活和删除前分别绑定用户审批；新 Agent 默认未注册、未激活、无 binding、不能派生子 Agent。

## 前置条件

- 已安装并可运行 OpenClaw（`openclaw --version` 正常）。本机验证：`2026.7.1-2 (0790d9f)`。
- Git（本机验证：`2.51.2.windows.1`）。
- PowerShell 7（Windows 主目标，本机验证：`7.6.4`）**或** Bash（本机验证：GNU bash 5.2.37）。
- Bash 实现需要现成的 `jq` 读取 package JSON；脚本不会自动安装它。

安装脚本**不会**自动安装任何依赖、不联网、不修改系统服务、不删除你已有的 OpenClaw Agent 或配置。

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

新的 manager 会话不依赖聊天历史。它会读取 `<runtime>/control/active-workflows.json`，再读取对应 `workflow.json`、`events.jsonl`、`context-summary.md`、未决审批与 Git 状态后恢复。快照与事件/Git 不一致时进入 `HOLD`。详见 [docs/state-and-recovery.md](docs/state-and-recovery.md)。

## 文档索引

- [docs/architecture.md](docs/architecture.md) — 新旧架构对比（删除 Python 控制平面）
- [docs/native-openclaw-integration.md](docs/native-openclaw-integration.md) — 使用了哪些原生 CLI 与工具
- [docs/manager-orchestration.md](docs/manager-orchestration.md) — 原生调度算法
- [docs/context-and-rule-passing.md](docs/context-and-rule-passing.md) — 上下文包与规则快照
- [docs/workflow.md](docs/workflow.md) — SDLC 阶段
- [docs/agent-contracts.md](docs/agent-contracts.md) — 输入输出契约
- [docs/state-and-recovery.md](docs/state-and-recovery.md) — 文件化状态与恢复
- [docs/git-worktree-strategy.md](docs/git-worktree-strategy.md) — 分支与 worktree
- [docs/evidence-and-claims.md](docs/evidence-and-claims.md) — 事实分级与命令日志
- [docs/human-approval.md](docs/human-approval.md) — 人工审批节点
- [docs/gate-checklists.md](docs/gate-checklists.md) — Gate 检查清单
- [docs/unsandboxed-test-policy.md](docs/unsandboxed-test-policy.md) — 无沙箱测试策略
- [docs/compatibility-report.md](docs/compatibility-report.md) — 实测 OpenClaw 版本与差异
- [docs/troubleshooting.md](docs/troubleshooting.md) — 排错
- [docs/threat-model.md](docs/threat-model.md) — 威胁模型
- [docs/component-management.md](docs/component-management.md) — Agent package、审批式生成、Skill Workshop 与删除边界

## 许可与安全

见 [SECURITY.md](SECURITY.md)。本项目不记录、不显示任何密钥/令牌/凭证。
