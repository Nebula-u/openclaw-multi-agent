# TOOLS.md — architect-agent 可用的 OpenClaw 原生工具

> 版本: architect-agent-tools v1
> 本文件规定本 Agent 允许使用的 OpenClaw 原生工具及其边界。凡本文件与 `TOOLS.md` 冲突处，以更严格者为准。**不得凭记忆假设不存在的工具名**；工具面以实际 OpenClaw `2026.7.1-2` 为准（见 `config/openclaw-config-notes.md`）。

> v3 覆盖：不得调用会话调度、Control Kernel mutation、monitor API、receipt/retry；JSON/JSONL 只写派发消息声明的 `.agent-raw` 暂存路径，绝不写最终 output JSON。

## 1. 允许使用的原生工具

### 1.1 文件工具（File）

- **读取（read-only）**：读取上下文包 `input/`（`context-manifest.json`、`context.md`、`rules.md`、`task.json`、`acceptance-criteria.json`、`approved-decisions.json`、`source-manifest.json`）、本 workspace 永久规则（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`rules/`）、以及 `source-manifest.json` 中列出的目标项目只读引用文件（用于理解现状与约束）。
- **写入（write）**：**仅**写入本次 run 的 `artifact_root_abs/output/`（含 `output/adr/` 下的 `ADR-*.md`）与 `artifact_root_abs/raw-logs/`。所有 mandatory 输出（见 `AGENTS.md`）都落在 `output/`。
- **禁止写入**：目标业务仓库、worktree、其他 Agent 的 workspace/agentDir、manager 控制目录、任何历史 run 目录、OpenClaw 配置、其他任务的 `input/`。

### 1.2 Shell 工具（Shell）

- 本 Agent 属架构设计角色，**默认不需要执行构建/测试/格式化命令**，也不产生代码。
- 仅允许**只读、非破坏性**的辅助命令：用原生工具计算文件 SHA-256 以完成 Preflight 与 `checksums.sha256`（如 PowerShell `Get-FileHash`、`sha256sum`、`shasum -a 256`）；读取文件/目录结构用于理解现状（只读列目录）。
- 每条执行的命令必须落 `command-records.jsonl`（字段见 `EVIDENCE_RULES.md`），stdout/stderr 存入 `raw-logs/`，保留绝对 `cwd` 与退出码。
- **禁止**：安装依赖、联网下载、破坏性命令（`rm -rf`、`git reset --hard`、`git clean -fdx` 等）、启动服务、修改系统环境、执行本项目自建的任何 Python 编排脚本。

### 1.3 Git 工具（Git，read-only）

- 仅允许**只读、本地**查询以完成 Preflight 与证据固化：如 `git -C <abs> rev-parse HEAD`、`git -C <abs> status`、`git -C <abs> log`（核对 `input_commit` 与当前 `HEAD`、理解现有仓库结构）。
- 本 Agent **不产生代码 commit**（架构正式报告与 ADR 写入 artifact，不污染业务仓库）。
- **禁止**：`push` / `pull` / `fetch` / 修改 remote / 远程 PR、`git init`、修改全局 Git 配置、破坏用户数据的命令、合并 integration 分支（合并权归 manager-agent）。详见 `rules/GIT_RULES.md`。

## 2. 绝对 cwd 规则

- 所有文件与命令使用**规范化绝对路径**；Git 命令用 `-C <abs>` 或原生 Shell 工具的绝对 cwd 显式指定目标目录。
- **不依赖当前工作目录**（即使从 `C:\Windows\System32` 启动）；不使用相对运行时路径（如 `./repo`、`../worktree`）。
- 所有路径规范化后必须校验位于允许根目录内，拒绝 `..` / 符号链接 / junction 逃逸。

## 3. 硬性禁止（本 Agent）

- **本 Agent 不得 spawn 其他 Agent**（`subagents.allowAgents = []`；跨 Agent 调度仅 manager-agent 通过原生 `sessions_spawn` 执行）。不得调用 `sessions_spawn` / `sessions_send` 派生或驱动其他 Agent。
- **不联网**（除非上下文包明确批准并记录）。
- **不安装**任何软件 / 依赖 / Docker。
- **不访问凭证 / 密钥目录**；配置与日志中不得出现 token / password / cookie / private key / 完整凭证。
- **不执行远程 Git 操作**，不修改全局 Git 配置。
- **不执行破坏性命令**。
- **不执行本项目新建的任何 Python 编排脚本**（本系统无 Python 控制平面）。
- **不修改** OpenClaw 配置、其他 Agent 的 workspace、历史 run 目录、已派发任务的 `input/`。
- **不做完整生产实现**、不修改目标业务仓库源码；非 API 项目不臆造 OpenAPI。
