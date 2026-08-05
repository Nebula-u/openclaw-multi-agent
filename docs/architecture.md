# architecture.md — 总体架构

> 项目：`openclaw-sdlc-multi-agent`
> 运行基座：OpenClaw `2026.7.1-2 (0790d9f)`（OBSERVED，来源 `artifacts/preflight/openclaw-version.stdout.txt`）
> 文档日期：2026-07-23

## 1. 本文用途

本文说明 `openclaw-sdlc-multi-agent` 的总体架构，**重点对比旧架构与新架构**，并给出三层架构文本图与目录说明。核心结论：本次重构**删除了"在 OpenClaw 之外再运行一套 Python 控制平面"的设计**，改由 `manager-agent` 依据固定**文件协议** + OpenClaw **原生工具**完成全部编排。日常工作流不运行本项目自建的 Python 脚本；唯一的项目运行时命令是无状态的 Node.js Runtime Guard 边界校验器。

本文中"必须""禁止""只能"均为硬性要求，与 `openclaw-native-architecture-rebuild-prompt.md`（下称"重构 Prompt"）第一、四、五、六节一致。

## 2. 旧架构 vs 新架构对比

| 维度 | 旧架构（已废弃） | 新架构（本项目） |
|------|------------------|------------------|
| 控制平面 | OpenClaw 之外单独运行 Python 控制平面（`sdlcctl` + orchestrator / dispatcher / state_store / gates / recovery / command_runner） | **无独立控制平面**；`manager-agent` 用文件协议 + OpenClaw 原生工具完成编排 |
| 运行时 CLI | 依赖 `sdlcctl` 等自建运行时 CLI | 不引入编排型 CLI；唯一例外是无状态 `scripts/runtime-guard.mjs`，依赖 Ajv 做 JSON Schema 校验，用于 fail-closed 边界校验 |
| 状态管理 | Python `state_store` / 状态机进程 | `manager-agent` 维护的文件：`workflow.json`、`events.jsonl`、`active-workflows.json` 等 |
| 上下文与规则传递 | Python 编排器组装并注入 | `manager-agent` 按 `CONTEXT_PROTOCOL` 生成任务上下文包与 `rules-snapshot.md` |
| 任务调度 | Python dispatcher 派发 | OpenClaw 原生跨 Agent 会话工具（如 `sessions_spawn`，显式传 `agentId`） |
| Gate | Python Gate 引擎 | `manager-agent` 按版本化检查清单逐项写 `gate-result.json` |
| 恢复 | Python recovery 服务 / daemon | `manager-agent` 读文件恢复（`active-workflows.json` → `workflow.json` → `events.jsonl` → Git） |
| 命令日志 | Python CommandRunner | OpenClaw 原生 Shell 工具执行 + 落盘 `command-records.jsonl` / `raw-logs/` |
| Python 角色 | 作为本系统运行时控制层 | **仅**当目标业务项目本身是 Python 项目时，`developer-agent` / `test-agent` 才编辑/执行该业务项目的 Python 代码 |
| 安装脚本 | 与运行时耦合 | **只在安装/配置阶段**使用（`install.ps1` / `install.sh`）；日常工作流不依赖它 |

新架构的四条要点（重构 Prompt 第二十四节第 11 条）：

1. **删除 Python control plane**：无 `sdlcctl`；无 Python orchestrator / dispatcher / state_store / gates / recovery / command_runner；无用于日常工作流的 `pyproject.toml`；不要求用户创建 Python 虚拟环境才能运行本系统。
2. **`manager-agent` 接管状态、上下文与规则传递**：它是唯一工作流总控，也是控制层文件的唯一写入者。
3. **OpenClaw 原生会话工具执行调度**：`manager-agent` 用原生跨 Agent 会话工具调用 package catalog 中已注册、已激活且允许调用的工作 Agent。
4. **安装脚本只在安装/配置阶段使用**：安装完成后，工作流只依赖 OpenClaw 原生 Agent、原生工具、文件与本地 Git。

## 3. 三层架构（文本图）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ A. OpenClaw 原生 Agent 层                                                   │
│    - 7 个真实注册的原生 Agent，各有独立 workspace 与 agentDir（绝对路径）    │
│    - 每个 Agent 的 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md              │
│    - manager-agent → 工作 Agent 的原生会话调度（sessions_spawn，显式 agentId）│
│    - 原生文件 / Shell / Git / 跨 Agent 会话工具                              │
│    - 用户消息默认只路由到 manager-agent                                      │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ 调度 / 校验 / 转述（原生会话工具，非 Python 进程）
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ B. manager-agent 文件化控制层（不是独立程序/服务，而是一组受协议约束的文件）  │
│    control/workflows/<workflow-id>/                                          │
│      workflow.json · user-request.md · context-summary.md ·                 │
│      rules-snapshot.md · events.jsonl · tasks/ · decisions/ · gates/ ·      │
│      final-report.md                                                        │
│    control/active-workflows.json · control/install-manifest.json ·          │
│    control/config-snapshots/                                                │
│    artifacts/<wf>/<task>/<run>/{input,output,raw-logs,checksums.sha256}     │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ Runtime Guard 边界校验与显式事务提交（不调度、不驻留）
                │ 分支 / worktree / commit / diff（仅本地 Git）
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ C. 本地 Git 隔离层                                                          │
│    - integration 分支：sdlc/<workflow-id>/integration                       │
│    - 任务分支：sdlc/<workflow-id>/<task-id>/<agent-id>/attempt-<n>          │
│    - 每个开发/重做/测试任务用独立分支 + 独立绝对路径 worktree               │
│    - 工作 Agent 只能改被分配的 worktree；manager-agent 负责创建/校验/合并    │
│    - 全程仅本地 Git：禁止 push / pull / fetch / remote                       │
└──────────────────────────────────────────────────────────────────────────┘
```

**唯一事实来源（不是聊天记录）**：用户原始需求文件、`manager-agent` 管理的结构化工作流文件、任务上下文包、Agent 结构化结果与原始报告、本地 Git commit / diff / worktree、原始命令日志与哈希。`manager-agent` 或 Gateway 中断后，新的 `manager-agent` 会话必须能仅凭这些文件恢复（见 `state-and-recovery.md`）。

## 4. 内置 Agent 与可插拔 Agent package

| Agent ID | 角色 | 是否可 spawn 其他 Agent |
|----------|------|--------------------------|
| `manager-agent` | 唯一工作流总控；默认唯一与用户交流者 | 是，白名单由 active/callable package 自动计算，`requireAgentId: true`，`delegationMode: prefer` |
| `requirement-agent` | 需求分析、验收标准（`AC-<n>`） | 否（`subagents.allowAgents=[]`） |
| `architect-agent` | 架构、接口、数据模型、威胁模型、测试策略 | 否 |
| `developer-agent` | 生产代码实现（真实本地 commit） | 否 |
| `review-agent` | 独立代码/测试审查（默认只读） | 否 |
| `test-agent` | 补充并执行测试（`sandbox.mode=off`，`UNSANDBOXED_LOCAL`） | 否 |
| `release-agent` | 运维前发布候选验证（`GO`/`NO_GO`/`HOLD`） | 否 |

所有 `register=true` Agent 的 workspace 与 agentDir **必须彼此不同且均为绝对路径**。内置 Agent 保持原 ID/路径；生成 Agent 使用 `agents/packages/generated/` 与 `runtime/agents/generated/` 隔离根。详见 `agent-contracts.md` 与 `component-management.md`。

## 5. 源项目目录说明

```text
D:\MicroConnect\project\openclaw-multi-agent\
├── README.md · SECURITY.md · CHANGELOG.md · .gitignore
├── config\                     # policy 与配置示例
│   ├── default-policy.yaml
│   ├── project-config.example.yaml
│   ├── agent-models.example.json
│   └── openclaw-config-notes.md
├── agents\
│   ├── common\                 # 6 份共享规则（安装时复制到各 workspace 的 rules\）
│   │   ├── COMMON_RULES.md · CONTEXT_PROTOCOL.md · EVIDENCE_RULES.md
│   │   └── GIT_RULES.md · APPROVAL_RULES.md · SECURITY_RULES.md
│   ├── manager-agent\workspace\   # AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / rules\ / templates\
│   ├── requirement-agent\workspace\
│   ├── architect-agent\workspace\
│   ├── developer-agent\workspace\
│   ├── review-agent\workspace\
│   ├── test-agent\workspace\
│   └── release-agent\workspace\
├── contracts\                  # JSON Schema 契约（字段以此为准）
├── templates\                  # workflow/task/context/result/report 等模板
├── scripts\                    # install/validate/restore 脚本及 runtime-guard.mjs
├── docs\                       # 本目录：架构与协议文档
├── examples\                   # demo-request / demo-policy / demo-project-config
└── artifacts\preflight\        # 只读环境探测的真实日志与 index.tsv
```

## 6. 安装后运行时目录说明

安装脚本创建用户可配置的 `runtime_root`。默认值相对**项目根目录**解析后再规范化为绝对路径，**不相对调用时的 `$PWD`**（见重构 Prompt 第六、七节；`install.ps1` 第 0 节）。下例假定 `runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime`：

```text
D:\MicroConnect\project\openclaw-multi-agent\runtime\
├── agents\<agent-id>\workspace\   # 自包含：prompt + rules\ 本地副本
├── agents\<agent-id>\state\       # 即 agentDir
├── control\
│   ├── workflows\<workflow-id>\{workflow.json,user-request.md,context-summary.md,
│   │                            rules-snapshot.md,events.jsonl,tasks\,task-runs\,
│   │                            transactions\,dispatch\,decisions\,gates\,final-report.md}
│   ├── active-workflows.json
│   ├── install-manifest.json      # 记录 runtime_root_abs、package/Agent 绝对路径、配置变更、校验结果
│   └── config-snapshots\
├── worktrees\<workflow-id>\<task-id>\<run-id>\repo\
└── artifacts\<workflow-id>\<task-id>\<run-id>\{input,output,raw-logs,checksums.sha256}
```

写入边界：`manager-agent` 是 `control/workflows`、`active-workflows.json`、任务 `input/`、`decisions/`、`gates/` 的**唯一逻辑写入者**；工作 Agent 只能写入本次 run 的 `output/`、`raw-logs/` 与被分配的 worktree。Runtime Guard 不是 daemon、dispatcher 或第二控制平面：它只在 manager 显式调用时执行校验或持久化。关键状态变化必须使用 `commit-transition`，由 Guard 在 workflow 锁内以 CAS 和事务日志一次提交 `events.jsonl`、`workflow.json`、`active-workflows.json` 与可选任务指针；`append-event` 仅为旧流程保留兼容。已派发任务的 `input/` 与已完成 run 目录**不可变**；`tasks/<task-id>.json` 只指向当前 run，重做时旧快照归档到 `task-runs/<task-id>/<run-id>.json`，不得覆盖旧报告/日志/结果。

## 6.1 Runtime Guard 可信边界

`node scripts/runtime-guard.mjs` 依赖 Node.js、Ajv 与 ajv-formats；安装后需先执行 `npm install` 以获得官方 JSON Schema validator。manager 在派发、合并、阶段推进、恢复和宣布完成等边界调用它；校验失败时 Guard 返回非零退出码与 `effective_status=HOLD`，manager 必须停止推进并按状态机记录处理结果。可用命令为：

- `validate-file`：用 Ajv 按本地 JSON Schema 校验一个 JSON 或 JSONL 文件，并拒绝未解析的运行时占位符；失败时可通过 `--log-file` 写入 `contracts/json-validation-error.schema.json` 约束的 JSONL 错误日志。
- `append-event`：仅供受控历史迁移测试兼容；manager 不得用它推进新 workflow。
- `commit-transition`：校验期望 revision 与全部下一版快照，在 workflow 锁内以事务日志和原子 rename 提交关键状态。
- `recover-transactions`：按 SHA-256 幂等滚动完成崩溃时遗留的 `PREPARED` / `APPLYING` 事务。
- `prepare-dispatch` / `record-dispatch-receipt` / `record-completion-receipt`：在 spawn 前后持久化幂等 intent、真实 session 与完成事实。
- `reconcile-dispatch` / `dead-letter-dispatch`：对账 lease/session，重试耗尽且已有失败事实后进入 dead letter。
- `check-workflow`：核对工作流快照、活动索引、事件链、任务/结果、审批、Gate 与候选 Git commit。
- `self-check`：用 Ajv strict mode 编译 contracts、校验状态机和受映射模板。

所有工作 Agent 的 JSON / JSONL 输出必须先在本 run 内自检；manager 在派发和接收边界再次校验。首次 JSON 校验失败只允许一次 JSON-only retry，只重生失败 JSON / JSONL，不重新完整分析任务；两次错误都必须保存在 `raw-logs/json-validation-errors.jsonl` 或 workflow 级 `validation-errors.jsonl`。

## 7. 绝对路径与 System32 防护

- 创建 Agent 时 `--workspace` 与 `--agent-dir` 必须为规范化后的**绝对路径**，禁止相对路径。
- 所有运行时任务/工作流/artifact/worktree/派发输入输出路径均为绝对路径。
- 即使 OpenClaw、Gateway、TUI、计划任务或终端从 `C:\Windows\System32` 启动，也必须依据 `install-manifest.json` 中的 `runtime_root_abs` 正确定位一切，**不依赖当前工作目录**。

## 8. 本阶段范围与已知限制

- 范围止于**运维前交付**：需求、架构、开发、审查、测试、构建验证、安全检查、发布前判定与运维交接材料。不实现真实部署、远程发布、CI/CD 接入、服务启停、生产数据迁移、生产凭证配置或在线回滚。
- **测试无 sandbox**：`test-agent` 的 `sandbox.mode=off`，每次测试记录 `isolation_mode=UNSANDBOXED_LOCAL`。这是当前阶段的**已知安全限制**；仍保留 workspace 隔离、Git worktree 隔离、绝对路径校验、命令边界、人工审批与证据记录。**不得声称当前已完全隔离**（详见 `unsandboxed-test-policy.md` / `threat-model.md`）。

## 9. 相关文档

- `native-openclaw-integration.md`：基于真实 CLI/schema 的集成方式。
- `manager-orchestration.md`：`manager-agent` 原生调度算法。
- `context-and-rule-passing.md`：上下文与规则传递协议。
- `workflow.md`：13 阶段主流程与状态机。
- `agent-contracts.md`：内置角色的输入校验与强制产物。
- `component-management.md`：Agent package、生成 Agent/Skill、审批与删除边界。
- `state-and-recovery.md`：文件化状态模型与恢复。
- `git-worktree-strategy.md`：本地 Git 与 worktree 策略。
