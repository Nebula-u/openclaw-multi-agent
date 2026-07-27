# Changelog

本项目遵循语义化的变更记录风格。日期格式 `YYYY-MM-DD`。

## [0.2.0] - 2026-07-27

### 可插拔 Agent package 与审批式生成组件

#### 新增（Added）

- Agent/Skill package、组件申请和构建结果契约。
- `agents/packages/builtin/`：7 个内置 Agent 的只读 package manifest，不移动或修改原 workspace。
- `agents/packages/generated/`：新 Agent/Skill 的唯一可写与可删除区域。
- `scripts/manage-components.ps1`：审批式构建、注册、激活、停用和删除生成 Agent，以及 Skill Workshop 接入。
- `agent-package-manager` workspace Skill；Skill 内容创建直接复用 OpenClaw bundled `skill-creator`。
- 生成 Agent 安全模板、组件策略和完整操作文档。

#### 变更（Changed）

- PowerShell/Bash 安装与验证脚本改为扫描 package manifest，不再维护固定 Agent ID 数组。
- Manager `allowAgents` 根据 register/active/callable package 自动计算。
- 安装同步增加配置差异跳过、快照、失败恢复和 schema v2 安装清单。

#### 安全（Security）

- 内置 Agent 强制 `protected=true`、`deletable=false`，组件工具拒绝修改和删除。
- 新 Agent 默认未注册、未激活、无 binding、`allowAgents=[]`。
- 构建、激活、删除均要求与 component request 匹配的用户审批响应。
- Skill 只能应用到生成 Agent；本阶段不创建 MCP。

## [0.1.0] - 2026-07-23

### 架构重构（Native OpenClaw Architecture Rebuild）

本次为底层架构重构：**删除 OpenClaw 之外的 Python 控制平面**，将全部编排职责收归 `manager-agent`（依据固定文件协议 + OpenClaw 原生工具）。保留原有 7 个 Agent 的角色与主流程。

#### 新增（Added）

- 7 个原生 OpenClaw Agent 的完整 workspace prompt（`AGENTS.md` / `SOUL.md` / `TOOLS.md` / `IDENTITY.md`）。
- 共享规则集 `agents/common/`（通用规则、上下文协议、证据规则、Git 规则、审批规则、安全规则）。
- `manager-agent` 文件化控制层协议：workflow/task/run/decision/gate/approval/recovery。
- OpenClaw 原生跨 Agent 会话调度协议（`sessions_spawn` + 显式 `agentId`）。
- 12 个 JSON Schema 契约（`contracts/`）。
- 15 个模板（`templates/`）。
- PowerShell 与 Bash 的安装 / 验证 / 恢复脚本，默认 dry-run，绝对路径处理，System32/非项目 cwd 防护。
- 15 篇文档（`docs/`），含实测兼容性报告与威胁模型。
- 只读环境探测脚本 `scripts/preflight-probe.sh` 及其产物 `artifacts/preflight/`。

#### 移除（Removed）

- 任何 Python 控制平面 / 编排器 / dispatcher / 状态机 / Gate 引擎 / CommandRunner / recovery 服务 / daemon。
- `sdlcctl` 或任何同类运行时 CLI。
- 用于日常工作流执行的 `pyproject.toml` 与 Python 虚拟环境要求。

#### 说明（Notes）

- 本阶段仅到"运维前交付"，不做真实部署 / 远程发布 / CI-CD / 服务启停 / 生产迁移 / 生产凭证。
- 测试阶段无 sandbox，记录 `isolation_mode=UNSANDBOXED_LOCAL`，属已知安全限制。
- 探测到的 OpenClaw 版本：`2026.7.1-2 (0790d9f)`。详见 `docs/compatibility-report.md`。
