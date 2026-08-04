# Changelog

本项目遵循语义化的变更记录风格。日期格式 `YYYY-MM-DD`。

## [Unreleased] - 2026-08-04

### 改动了什么

- 新增 `check-task-package` Guard 命令，在写入 `TASK_DISPATCHED` 事件和创建 Agent 会话前校验完整 input package、manifest 哈希、规范 artifact 路径与规范 worktree 路径。
- 新增 `QUARANTINED` 工作流终态。该终态要求 append-only 隔离事件、`quarantine-report.md`、`final-report.md` 和活动索引移除；Guard 只在审计边界通过后允许其结束，不会改写历史 task/run 证据。
- `task.json` 新增 `structured_outputs[]`。Manager 必须声明跨 Agent JSON/JSONL 的产出路径、Schema、格式、是否必需和产出 Agent；完成任务由 Guard 再次以 Ajv 校验声明产物。
- 新增 `config/manager-session-policy.json`，保持 `thinking=high` 和 200k 模型窗口，同时将 Manager 会话软预算设为 80%（160k token），达到预算后从文件化状态创建新会话恢复。
- 已将运行中的 `WF-ef1c5f87-93c5-4ec7-a074-3dea54831ca1` 正式隔离为 `QUARANTINED`，保留原始控制面、artifact 与 Guard 错误证据，不再参与恢复。
- 清除了 `manager-agent` 父会话及当时两个 TUI 会话遗留的 `providerOverride`、`modelOverride` 与 `modelOverrideSource`。这些会话级字段曾将 Manager 的实际调用模型固定为 DeepSeek。
- 保持 OpenClaw Agent 配置的 Manager 默认模型为 `newapi-responses/gpt-5.6-luna`，未改动其余 6 个项目 Agent、平台 `main` Agent、模型凭据或历史工作流会话。
- 规定后续项目改动须在用户完成检查/验收后，同步更新本文件、`README.md` 与 `docs/current-progress-assessment.md`，记录变更、验证结果、完成状态与遗留风险。
- 7 个 Agent 的项目配置与路由样例统一改为官方 `deepseek/deepseek-v4-pro` + Chat Completions API；不再将任何默认 Agent 路由到 Responses API。
- JSON/JSONL LLM 回复链路新增保守清洗：去 BOM、去唯一 Markdown fence、或从唯一解释性前后缀中提取完整 JSON/JSONL；多个候选一律拒绝猜测，并记录原始/清洗 SHA-256 与转换元数据。
- 新增 enum、type、schema drift、输出截断和空 content 的固定重写模板；所有类别共用首次调用之外最多两次的同会话重试预算。核心 `result`、`task` 与 JSON 校验错误契约为身份、状态、枚举、结构化产物和错误字段增加了描述。
- 新增 `docs/llm-json-recovery.md`，记录清洗边界、两段可复核模板和 DeepSeek JSON Output 的官方要求与当前 Gateway 限制。本项实现与文档为待用户验收状态。

### 为什么要改

- 历史 workflow 在 manifest、输入哈希、任务事件和 worktree 路径上发生不一致，导致 Guard 正确 fail-closed；此前缺少派发前预检与可审计的隔离出口。
- 同一 Manager 会话持续携带完整工具日志和失败记录，造成 token 消耗与流中断风险；当前实际使用未触及 200k 上限，因此扩大窗口不能解决问题。
- 既有 Ajv 校验未把所有任务声明的结构化产物纳入控制面复检。
- `openclaw models status --agent manager-agent --check` 显示的 Agent 默认模型已正确配置为 Luna，但 TUI 创建的新会话会继承父会话保存的 DeepSeek 覆盖，导致界面和实际调用与项目模型路由不一致。
- 仅修正运行时配置不足以防止会话层覆盖重新造成误判；项目状态、用户可见操作说明和变更历史也需要在验收后保持一致。

### 改后的效果

- 新任务在派发前即可因缺失 input、哈希不符或路径异常被拒绝，不会先写入不一致的 `DISPATCHED` 状态。
- 无法在不篡改不可变历史的前提下修复的 workflow 可以被隔离并从恢复索引移除；新任务必须从新的 workflow 重建。
- 已声明 JSON/JSONL 产物在完成时必须通过其受信任 contract；聊天文本和 Markdown 摘要不能单独推动状态。
- Manager 在 160k token 时换新会话并由 `recovery-check` 从文件恢复，避免用扩大窗口掩盖上下文累积。
- 重新启动 Manager TUI 后，新会话会使用 `newapi-responses/gpt-5.6-luna`，不再继承 `deepseek/deepseek-v4-flash`。
- 已存在的历史会话和工作流产物保留原始记录；本次只移除了会改变后续调用路由的覆盖字段。
- 后续状态不会在未完成用户检查时提前标记为已验证；验收后将由三份项目文档共同反映实际状态。
- 配置样例与路由文档已统一到 DeepSeek V4 Pro Chat Completions，避免当前 Gateway 的 Responses 路径限制影响 Agent 调用。
- 格式错误不再依赖模型自我修复：已知包装问题可确定性清除，enum/type 不合法、schema drift 和截断会获得精确诊断并 fail-closed；两次重写后仍失败保留全链路证据。

### 验证

- `npm test` 通过：82 项 Runtime Guard 测试通过，2 项因当前 Windows 会话无符号链接权限跳过；离线 LLM harness 8 项和安装验证 2 项通过。
- `check-workflow` 已对被隔离 workflow 返回 `effective_status=QUARANTINED`、`state_revision=9`、`event_count=9`。
- Manager 父会话及相关 TUI 会话均已确认不存在 provider/model override。
- `openclaw config validate` 已验证当前 OpenClaw 配置；7 个 Agent 的有效模型统一为 `deepseek/deepseek-v4-pro`。
- 待本次变更完成后运行 `npm test`、`git diff --check` 与安装校验；真实 DeepSeek 调用不在本地离线测试中执行。

## [0.2.2] - 2026-07-30

### 改动了什么

- Runtime Guard 的 JSON Schema 校验从自研子集校验改为 Ajv / ajv-formats，本地支持 Draft-07 与 Draft 2020-12 schema。
- 新增 `contracts/json-validation-error.schema.json` 与 `templates/json-regeneration-retry-prompt.md`，约束 JSON 校验失败日志和一次 JSON-only retry 提示。
- 所有内置工作 Agent、生成 Agent 模板和 manager 调度规则新增 JSON / JSONL 强校验要求：Agent 自检时校验，manager 在派发和接收边界再次校验。
- `validate-file` 失败输出增加 `validator: "ajv"`，可通过 `--log-file`、`--stage`、`--agent-id`、`--workflow-id`、`--task-id`、`--run-id`、`--attempt` 等参数记录错误主体和错误内容。
- 安装校验脚本增加 Ajv 依赖检查；README 与架构/契约/编排文档同步说明 `npm install`、Ajv validator、错误日志和 JSON-only retry。

### 为什么要改

- 让 JSON Schema 校验覆盖完整标准能力，避免自研子集遗漏 schema 语义。
- 防止 LLM 生成的 JSON 在 Agent 自检或 Agent 通信边界以“格式大致正确”通过。
- 在 JSON 失败时保留可追溯日志，并限制重试范围，避免一次格式修复被误做成重新分析或改变既有结论。

### 改后的效果

- 所有 JSON / JSONL 产物必须先本地 Ajv 强校验，再由 manager 在边界复检。
- 首次 JSON 校验失败只允许一次重试，且重试只能重新生成失败 JSON / JSONL，不得重新完整分析任务。
- 校验失败会保留结构化 JSONL 日志，包含失败主体、schema、validator errors、失败内容摘要、内容哈希、重试次数和最终状态。
- `runtime-guard self-check` 现在会用 Ajv strict mode 编译 contracts，并校验 19 个 contract 与 10 个模板。

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
