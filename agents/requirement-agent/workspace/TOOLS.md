# TOOLS.md — requirement-agent 可用的 OpenClaw 原生工具

> 版本: requirement-agent-tools v1
> 本文件规定本 Agent 允许使用的 OpenClaw 原生工具及其边界。凡本文件与 `TOOLS.md` 冲突处，以更严格者为准。**不得凭记忆假设不存在的工具名**；工具面以实际 OpenClaw `2026.7.1-2` 为准（见 `config/openclaw-config-notes.md`）。

> v4 边界：不得调用会话调度、checkpoint mutation、monitor API、receipt/retry/approval；JSON/JSONL 只写派发消息声明的 `.agent-raw` 暂存路径。

## 1. 允许使用的原生工具

### 1.1 文件工具（File）

- **读取（read-only）**：读取上下文包 `input/`（`context-manifest.json`、`context.md`、`rules.md`、`task.json`、`acceptance-criteria.json`、`approved-decisions.json`、`source-manifest.json`）、本 workspace 永久规则（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`rules/`）、以及 `source-manifest.json` 中列出的目标项目只读引用文件。
- **写入（write）**：仅写入本次 run 的 `.agent-raw/` 与 `raw-logs/`；最终 `output/` 由宿主 ingestion 发布。
- **禁止写入**：目标业务仓库、worktree、其他 Agent 的 workspace/agentDir、manager 控制目录、任何历史 run 目录、OpenClaw 配置、其他任务的 `input/`。

### 1.2 Shell 工具（Shell）

- 本 Agent 属需求分析角色，**默认不需要执行构建/测试/格式化命令**。
- 仅允许**只读、非破坏性**的辅助命令：用原生工具计算文件 SHA-256 以完成 Preflight 与 `checksums.sha256`（如 PowerShell `Get-FileHash`、`sha256sum`、`shasum -a 256`）；读取文件内容用于分析。
- 每条执行的命令必须落 `command-records.jsonl`（字段见 `EVIDENCE_RULES.md`），stdout/stderr 存入 `raw-logs/`，保留绝对 `cwd` 与退出码。
- **禁止**：安装依赖、联网下载、破坏性命令（`rm -rf`、`git reset --hard`、`git clean -fdx` 等）、启动服务、修改系统环境、执行本项目自建的任何 Python 编排脚本。

### 1.3 Git 工具（Git，read-only）

- 仅允许**只读、本地**查询以完成 Preflight 与证据固化：如 `git -C <abs> rev-parse HEAD`、`git -C <abs> status`、`git -C <abs> log`（读取 `input_commit` 与当前 `HEAD` 是否一致）。
- 本 Agent **不产生代码 commit**（需求正式报告写入 artifact，不污染业务仓库）。
- **禁止**：`push` / `pull` / `fetch` / 修改 remote / 远程 PR、`git init`、修改全局 Git 配置、破坏用户数据的命令、合并或推进候选提交。详见 `rules/GIT_RULES.md`。

## 2. 绝对 cwd 规则

- 所有文件与命令使用**规范化绝对路径**；Git 命令用 `-C <abs>` 或原生 Shell 工具的绝对 cwd 显式指定目标目录。
- **不依赖当前工作目录**（即使从 `C:\Windows\System32` 启动）；不使用相对运行时路径（如 `./repo`、`../worktree`）。
- 所有路径规范化后必须校验位于允许根目录内，拒绝 `..` / 符号链接 / junction 逃逸。

## 3. 硬性禁止（本 Agent）

- **本 Agent 不得调用其他 Agent**。跨 Agent 工具白名单为空，派发只由宿主 StateGraph `dispatch` 节点执行。
- **不联网**（除非上下文包明确批准并记录）。
- **不安装**任何软件 / 依赖 / Docker。
- **不访问凭证 / 密钥目录**；配置与日志中不得出现 token / password / cookie / private key / 完整凭证。
- **不执行远程 Git 操作**，不修改全局 Git 配置。
- **不执行破坏性命令**。
- **不执行本项目新建的任何 Python 编排脚本**（本系统无 Python 控制平面）。
- **不修改** OpenClaw 配置、其他 Agent 的 workspace、历史 run 目录、已派发任务的 `input/`。
- **不编写生产代码**、不修改目标业务仓库源码。
