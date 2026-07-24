# openclaw-sdlc-multi-agent

在**已部署的 OpenClaw**（本机验证版本 `2026.7.1-2`）之上，使用 OpenClaw **原生多 Agent、独立 workspace、原生跨 Agent 会话调度、文件工具、Shell 工具和本地 Git 工具**，实现从需求到"运维前交付"的软件开发生命周期（SDLC）流程。

> **本项目没有 Python 控制平面。** 日常工作流不启动任何后台服务、不执行本项目自建的编排脚本、不依赖 Python 运行时。全部编排由 `manager-agent` 依据固定文件协议 + OpenClaw 原生工具完成。安装脚本（PowerShell / Bash）**仅**在安装与配置阶段使用。

## 这是什么

7 个在 OpenClaw 中真实注册、彼此隔离的原生 Agent，协作完成：

| Agent | 角色 |
|-------|------|
| `manager-agent` | 唯一工作流总控；管理状态、上下文、规则、Gate、审批、Git 合并；用原生会话工具调度其余 6 个 Agent |
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

## 前置条件

- 已安装并可运行 OpenClaw（`openclaw --version` 正常）。本机验证：`2026.7.1-2 (0790d9f)`。
- Git（本机验证：`2.51.2.windows.1`）。
- PowerShell 7（Windows 主目标，本机验证：`7.6.4`）**或** Bash（本机验证：GNU bash 5.2.37）。

安装脚本**不会**自动安装任何依赖、不联网、不修改系统服务、不删除你已有的 OpenClaw Agent 或配置。

## 快速开始（Windows / PowerShell 7）

安装脚本默认只做 **dry-run**，不会修改你的 OpenClaw 配置。可从任意目录调用——脚本会相对自身位置解析项目根目录并规范化为绝对路径。

```powershell
# 1) 预演（默认 dry-run，不写入任何 OpenClaw 配置）
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\install.ps1" `
  -RuntimeRoot "d:\MicroConnect\project\openclaw-multi-agent\runtime"

# 2) 静态验证（不改配置）
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\validate-install.ps1" `
  -RuntimeRoot "d:\MicroConnect\project\openclaw-multi-agent\runtime"

# 3) 真正注册 7 个 Agent（会修改 OpenClaw 配置；先自动备份，再校验）
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
bash /abs/path/openclaw-sdlc-multi-agent/scripts/install.sh \
  --runtime-root /abs/path/openclaw-sdlc-multi-agent/runtime

# 静态验证
bash /abs/path/openclaw-sdlc-multi-agent/scripts/validate-install.sh \
  --runtime-root /abs/path/openclaw-sdlc-multi-agent/runtime

# 真正注册（修改配置，先备份）
bash /abs/path/openclaw-sdlc-multi-agent/scripts/install.sh \
  --runtime-root /abs/path/openclaw-sdlc-multi-agent/runtime --apply --yes
```

## 恢复 OpenClaw 配置

```powershell
pwsh -File "d:\MicroConnect\project\openclaw-multi-agent\scripts\restore-openclaw-config.ps1" `
  -SnapshotPath "<runtime>\control\config-snapshots\openclaw.json.<timestamp>.bak"
```

```bash
bash /abs/path/scripts/restore-openclaw-config.sh \
  --snapshot "<runtime>/control/config-snapshots/openclaw.json.<timestamp>.bak"
```

恢复脚本只恢复你明确选择的快照，覆盖前会再次备份当前配置。**恢复配置 ≠ 删除 workspace**，两者是不同操作。

## 如何把需求交给 manager-agent

安装并注册后，在 OpenClaw 中与 `manager-agent` 对话（默认只有它直接与用户交流）。给它：

1. 你的原始需求（自然语言）。
2. 目标业务项目的**绝对路径**。

`manager-agent` 会保存原始需求、规范化目标路径、探测 Git 状态、创建 `workflow.json`，然后按 SDLC 阶段调度其余 Agent。详见 [docs/workflow.md](docs/workflow.md) 与 [docs/manager-orchestration.md](docs/manager-orchestration.md)。

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

## 许可与安全

见 [SECURITY.md](SECURITY.md)。本项目不记录、不显示任何密钥/令牌/凭证。
