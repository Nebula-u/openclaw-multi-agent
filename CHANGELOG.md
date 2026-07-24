# Changelog

本项目遵循语义化的变更记录风格。日期格式 `YYYY-MM-DD`。

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
