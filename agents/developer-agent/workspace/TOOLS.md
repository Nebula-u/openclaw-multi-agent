# TOOLS.md — developer-agent 可用的 OpenClaw 原生工具与边界

> Agent ID: `developer-agent`
> 版本: developer-agent-tools v1
> 本文件说明本 Agent 使用哪些 OpenClaw **原生工具**、各自用途与硬性边界。工具行为以当前安装版本（本机 `OpenClaw 2026.7.1-2`）的实际 `--help` 与 `config schema` 为准。

> v4 边界：不得调用会话调度、checkpoint mutation、monitor API、receipt/retry/approval；JSON/JSONL 只写派发消息声明的 `.agent-raw` 暂存路径。

## 1. 文件工具（读 / 写）

- **用途**：读取本次 run 的 input；在被分配的 worktree 内修改授权代码；向 `.agent-raw/` 与 `raw-logs/` 写入原文、证据与日志。
- **边界**：
  - 只能写入 manifest 授权的 worktree 路径，以及本次 run 的 `.agent-raw/`、`raw-logs/`。
  - 不得写入/读取：manager 控制目录中与本任务无关的内容、其他 Agent 的 workspace/agentDir、其他任务的 `input`、任何历史 run 目录（不可变）、OpenClaw 配置文件。
  - 已派发任务的 `input/` 视为**只读且不可变**。

## 2. Shell 工具（命令执行）

- **用途**：执行构建、编译、格式化、开发者自测等命令，以支撑"是否可运行"的结论；计算文件哈希（用系统原生工具，如 `Get-FileHash` / `sha256sum` / `shasum -a 256`）。
- **命令日志义务（硬性）**：每条构建/测试/格式化/关键命令都必须落盘为真实 CommandRecord（见 `rules/EVIDENCE_RULES.md`），至少含 `command_record_id`、准确命令文本/`argv`、`executable`、`executable_version`、`cwd_abs`、`started_at`、`finished_at`、`exit_code`、`timed_out`、`stdout_path_abs`、`stderr_path_abs`、`stdout_sha256`、`stderr_sha256`、`attempt`、`invoked_by_agent`、`task_id`、`run_id`、`isolation_mode`、`redactions_applied`。
  - stdout / stderr 必须保存为 `raw-logs/` 下**独立原始文件**，保留真实退出码与绝对 `cwd`。
  - **重试生成新日志与新 CommandRecord，绝不覆盖或删除第一次失败**。
  - 未执行的检查标记 `NOT_EXECUTED` / `UNKNOWN`，不得假装执行。
  - 严禁编造 stdout/stderr、退出码、工具版本。
- **绝对 cwd 规则**：所有命令必须显式在**绝对路径**下执行（worktree 或目标项目绝对路径）。**禁止依赖当前工作目录**，禁止相对运行时路径（如 `./repo`、`../worktree`）——即使会话从 `C:\Windows\System32` 启动也必须正确定位。
- **默认禁止**：网络访问、安装软件/依赖、修改系统服务/注册表/计划任务/全局环境变量、访问凭证或密钥目录、破坏性命令。**不得执行本项目新建的任何 Python 编排脚本**（本系统无 Python 控制平面）；若目标业务项目本身是 Python 项目，可执行**该业务项目自身**的 Python 命令。

## 3. 本地 Git 工具（仅限被分配 worktree）

- **用途**：在被分配的 worktree 内 `add` / `commit` 本次生产修改；用 `git -C "<abs>" status/diff/rev-parse/cat-file/log` 核对状态与 commit。
- **commit 信息**：使用 `rules/GIT_RULES.md` 第 5 节 trailer 格式（`<agent-id>: <task-id> <简要说明>` + `Workflow-ID`/`Task-ID`/`Run-ID`/`Agent-ID`/`Attempt`/`Input-Commit`）。
- **绝对禁止**：
  - 远程操作：`push` / `pull` / `fetch` / 修改 remote / 远程 PR。
  - 破坏性命令：`git reset --hard` / `git clean -fdx` / 强删分支或 worktree 中未合并工作。
  - 修改**全局** Git 配置；Git identity 只写入该 worktree 对应仓库的**本地**配置。
  - 合并或推进 integration/candidate 分支。
  - 擅自 `git init` 或对未提交修改自动 commit/stash/丢弃/reset。
- **cwd 规则**：所有 Git 命令用 `-C <abs>` 或原生 Shell 工具的绝对 cwd 显式指定目标仓库/worktree，禁止相对路径。

## 4. 跨 Agent 会话权限（本 Agent 无）

- 跨 Agent 工具对白名单中的所有 worker 均关闭；唯一派发入口是宿主 StateGraph `dispatch` 节点。
- **本 Agent 不得调用其他 Agent。** 跨 Agent 工具白名单为空；需要其他角色介入时，只在结果中报告事实，由 StateGraph 处理。

## 5. 网络 / 安装 / 凭证 / 远程（全体默认禁止）

- 默认**不联网**、**不安装**软件或依赖、**不访问凭证/密钥**、**不执行远程 Git**。
- 任何上述需求都属人工审批节点：返回 `HUMAN_DECISION_REQUIRED`，由 StateGraph 生成绑定审批，不自行开启。
