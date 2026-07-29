# Changelog

本项目遵循语义化的变更记录风格。日期格式 `YYYY-MM-DD`。

## [0.2.1] - 2026-07-29

### 改动了什么

- 新增依赖 Node.js 标准库的无状态 Runtime Guard、工作流状态机、事件/审批/Gate 契约和对应模板。
- 文档补充 Guard 命令、fail-closed 边界、状态迁移、canonical 事件哈希、Gate 聚合与审批绑定规则。
- 收紧终态 current authority：终态 workflow 必须从 active index 移除并具有非空 final report；canonical serializer 对顶层与嵌套数字形态键按 Unicode 码点排序。
- 收紧 review/release lineage：finding 只按 current candidate 和可信 task event `seq` closure；ReleaseReadinessGate 精确绑定当前 release task/run 的唯一 decision、checks 与证据。
- 补强 current authority 边界：ReviewGate/SecurityGate 的 PASS 必须引用 current candidate 的合法 review-agent 证据；历史 release gate/decision 只校验自身 task/run，不参与当前候选或终态裁决，同 candidate 的旧 release rerun 也不能覆盖最新 release task/run；release 终态要求恰好一个最新 release task/run gate。

### 为什么要改

- 使控制快照、事件链、任务结果、审批和 Gate 在派发、合并、阶段推进、恢复与完成声明时得到同一套可执行一致性校验。
- 避免旧 candidate 的开放 finding、旧 release run decision 或 JavaScript 整数键重排错误夺取当前候选的权威；避免 FAIL/HOLD Gate 在缺少当前 release decision 时被接受。
- 避免 Review/Security Gate 在没有当前 review 的情况下仅凭旧证据 PASS，同时避免历史 release HOLD/NO_GO 或同 candidate 旧 rerun 与当前 release GO 终态相互冲突；避免最新 release task 尚无 gate/decision 时终态失去 verdict 约束。

### 改后的效果

- `manager-agent` 继续是唯一编排者和控制文件写入者；Guard 不充当 daemon、dispatcher 或第二控制平面。
- 无效状态迁移、快照/事件不一致、未决审批、开放阻断 finding 或 Gate/release verdict 不一致会 fail-closed。
- 后续 `RESOLVED` 可按可信 event `seq` 关闭同 candidate 的旧 `OPEN`，歧义则 HOLD；旧 candidate finding 与旧 release run 保留但不参与当前 Gate。
- Review/Security Gate 只有绑定 current candidate 的 review evidence 才能 PASS；历史 release artifact 保留并自洽校验，但不会覆盖最新 release task/run 的 verdict 或 workflow 终态；release 终态缺少最新 release gate 会 fail-closed。
- Release checks 以保守顺序重算：`HOLD`/`UNKNOWN`/`NOT_APPLICABLE` 优先为 `HOLD`，其后 `FAIL` 为 `NO_GO`，仅非空全 PASS 为 `GO`，空 checks 为 `HOLD`；decision/check evidence 限定当前 release task/run。
- 已提供 Node.js 测试；本机没有 `pwsh`，未在本机声明 PowerShell 测试通过。

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
