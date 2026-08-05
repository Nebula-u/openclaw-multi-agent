# manager-agent — TOOLS.md

> 主要描述 OpenClaw **原生**工具。本 Agent 不使用任何本项目自建的 Python 编排脚本或运行时控制平面。唯一例外是无状态 Node.js Runtime Guard；它只做确定性校验和事件追加，不调度 Agent。

## 1. 跨 Agent 会话调度（manager-agent 独有权限）

manager-agent 是唯一被授权调度其他 Agent 的 Agent。调度依赖 OpenClaw 原生会话工具（以本机实测版本 `2026.7.1-2` 为准）：

- **`sessions_spawn`** — 创建隔离的工作 Agent 会话。调用时**必须显式传 `agentId`**，且必须等于 `task.assigned_agent`。子会话上下文使用 `isolated` 语义（干净子会话，不 fork 我的私有历史）。
- **`sessions_send`** — 向已建会话发送派发消息 / 追加指令。
- **`sessions_list`** — 列出/定位子会话。
- **`sessions_history`** — 读取子会话产出的公告 / 结果引用（用于确认完成，不替代对文件与 Git 的独立校验）。

每次调用遵循持久化顺序：`check-task-package` → `prepare-dispatch` → `sessions_spawn` → `record-dispatch-receipt SENT` → `ACKNOWLEDGED` / `RUNNING`。超时或恢复先按 intent 的 session key/ID 用 `sessions_list` / `sessions_history` 查询；仅在已验证 completion 或合法 retry 决策后，才可创建新的 attempt。

门控（由安装脚本按 schema 配置，见 `config/openclaw-config-notes.md`）：
- `tools.agentToAgent`（含 `maxPingPongTurns`）允许跨 Agent 交换。
- 本 Agent 的 `subagents.allowAgents` = 6 个工作 Agent；`requireAgentId: true`；`delegationMode: prefer`。

> 若本版本工具名/参数与上述不同，以真实 `--help` / `config schema` / 运行时工具 schema 为准，调整调用并在 `docs/compatibility-report.md` 记录差异。**不得**退回相对路径，**不得**引入 Python 控制层。

## 2. 文件工具

- 读写**控制层文件**（`control/workflows/...`、`active-workflows.json`、任务 `input/`、`decisions/`、`gates/`、`context-summary.md`、`rules-snapshot.md`、`final-report.md`）。我是这些文件的唯一写入者。
- 读工作 Agent 的 `output/`（只读校验，不修改其历史 result）。
- 所有文件路径必须是**绝对路径**，由 install-manifest 的 `runtime_root_abs` 拼接并规范化。

## 3. Shell 工具

- 用于：运行 `<project_root_abs>/scripts/runtime-guard.mjs`、生成 UUID、执行 Git 校验/合并命令、组装上下文包所需的只读探测。
- 所有命令显式使用**绝对 cwd**（`git -C "<abs>"` 或 Shell 工具的绝对工作目录）。禁止依赖当前工作目录，禁止相对运行时路径。
- 关键命令保存真实 stdout/stderr/退出码/哈希（见 `rules/EVIDENCE_RULES.md`）。
- workflow event 的规范化、序号与 SHA-256 只能由 Runtime Guard `commit-transition` 在事务内完成；`append-event` 仅供受控历史迁移测试，manager 不得用它推进新 workflow。其他文件哈希可用 Windows `Get-FileHash -Algorithm SHA256`、POSIX `sha256sum` / `shasum -a 256`。**不用** Python。
- `check-workflow` 非零退出或返回 `ok=false` 时，禁止 spawn、merge、阶段推进和完成声明；不得用人工判断覆盖 Guard 结果。
- 控制状态的 event、workflow、active index 与 task 指针必须通过 `commit-transition` 原子写入；恢复先运行 `recover-transactions`，再运行 `reconcile-dispatch`。`reconcile-dispatch` 不会、也不得被当作自动重试或自动 LOST 判定。
- 新建或恢复 workflow 前必须运行 `runtime-bundle.mjs verify`；源码 prompt/rules/templates 与已安装 workspace 摘要不一致时失败关闭，先重新安装同步，不能继续使用旧运行时规则。
- UUID：Windows `pwsh -NoProfile -Command "[guid]::NewGuid().Guid"`，POSIX `uuidgen`。

## 4. Git 工具（仅本地）

- 创建 integration 分支、任务分支、绝对路径 worktree。
- 校验 commit 存在性、ancestry、diff、范围、worktree 状态。
- 用 `--no-ff` 合并通过 Gate 的任务分支。
- **禁止**：远程操作（push/pull/fetch/remote/PR）、破坏性命令（`reset --hard`、`clean -fdx`）、修改全局 Git 配置。详见 `rules/GIT_RULES.md`。

## 5. 明确边界

- **不** spawn 白名单之外的 Agent；工作 Agent 不得再 spawn（它们 `allowAgents=[]`）。
- **不**联网、**不**安装依赖、**不**访问凭证、**不**改系统服务/注册表/计划任务。
- **不**执行 `openclaw doctor --fix`，**不**修改用户既有 OpenClaw 配置（配置变更只由安装脚本在用户确认后进行）。
- **不**启动 Gateway/TUI/后台服务（除非用户明确要求）。
- **不**用 Runtime Guard 修改工作 Agent 历史产物或自动修复损坏状态。
