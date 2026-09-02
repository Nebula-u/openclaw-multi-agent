# TOOLS.md — review-agent

> 版本: review-agent-tools v1
> 本文件规定 review-agent 允许使用的 OpenClaw 原生工具与硬性边界。凡本文件未列出的能力，一律视为禁止。

> 当前边界：不得调用会话调度、Kernel/snapshot mutation、Monitor API、receipt/retry/approval；JSON/JSONL 只写派发消息声明的 `.agent-raw` 暂存路径。

## 1. 允许使用的 OpenClaw 原生工具

- **文件读取（file read）**：读取上下文包 `input/`、`source-manifest.json` 中列出的源文件、被评审 worktree 中的生产代码与测试代码（只读）、`rules/` 下 6 份通用规则本地副本。
- **只读 Shell（shell，仅只读检查 / 验证命令）**：仅用于只读的检查与验证，例如查看文件内容、列目录、统计行数、计算文件 SHA-256（`Get-FileHash` / `sha256sum` / `shasum -a 256` 等原生工具）、以及**只读**的静态检查命令。所有命令必须按 EVIDENCE_RULES.md 记录为 CommandRecord，stdout/stderr 落盘到 `raw-logs/`。
- **只读 Git（git read-only）**：仅允许只读子命令，例如 `git -C <abs> log`、`show`、`diff`、`status`、`rev-parse`、`cat-file`、`blame`，用于把 finding 定位到具体 commit/行号，并校验 `input_commit` 与 `HEAD` 一致。

## 2. 绝对 cwd 规则

- 所有 Shell 与 Git 命令必须显式使用**绝对路径**（Git 用 `-C <abs>` 或原生 Shell 工具的绝对 cwd）。
- 禁止依赖当前工作目录，禁止相对运行时路径（如 `./repo`、`../worktree`）。即使从 `C:\Windows\System32` 启动也必须给绝对路径。
- 所有读写路径规范化后必须落在允许根目录内：读取限于 input、清单源文件和被分配 worktree；写入仅限本次 run `.agent-raw/` 与 `raw-logs/`。

## 3. 本 Agent 不得 spawn 其他 Agent

- **本 Agent 不得 spawn 其他 Agent。** `subagents.allowAgents = []`。
- 不得调用或指挥其他 Agent；唯一派发入口是宿主 Orchestrator。
- 需要上游澄清或他人改代码时，返回相应状态和证据，由 Orchestrator 处理，不自行派生。

## 4. 明确禁止

- **不修改生产代码或测试代码**（默认只读评审）；不写入被评审 worktree；不产生业务仓库 commit。
- **不联网**（禁止下载依赖、拉取远程规则、访问外部服务）。
- **不安装**任何软件 / 依赖 / 工具。
- **不访问凭证 / 密钥目录**；日志脱敏（`redactions_applied`），发现明文凭证只作安全发现上报，不复制明文到 artifact。
- **不执行远程 Git**（push / pull / fetch / remote / 远程 PR）。
- **不执行破坏性命令**（`git reset --hard`、`git clean -fdx`、递归删除等）。
- **不修改**全局 Git 配置、OpenClaw 配置、其他 Agent 的 workspace/agentDir、其他任务 input、历史 run 目录。
- **不执行本项目新建的任何 Python 编排脚本**（本系统无 Python 控制平面）；校验和用原生工具计算。
- 静态分析工具未安装或未运行 → 标 `NOT_EXECUTED` / `UNKNOWN`，不得伪造执行。
