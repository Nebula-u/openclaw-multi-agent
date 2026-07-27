# native-openclaw-integration.md — 基于真实 CLI / schema 的原生集成

> 探测基准版本：OpenClaw `2026.7.1-2 (0790d9f)`（OBSERVED，来源 `artifacts/preflight/openclaw-version.stdout.txt`）
> 配置文件位置：`~\.openclaw\openclaw.json`（OBSERVED，来源 `openclaw config file`）
> 文档日期：2026-07-23

## 1. 本文用途

本文说明本项目**如何基于真实的 OpenClaw CLI 与 config schema 进行集成**：安装脚本从 Agent package catalog 读取所有 `register=true` 的 Agent，用 `agents add` 注册绝对 `workspace` / `agentDir`，用 `config set` 的 **bracket 路径**精确修改 `subagents` 与 `sandbox`，用 `config validate` 校验，用 `agents list --json` / `config get agents.list --json` 复核。所有字段名与参数以本机实测 `--help` 与 `config schema` 为准，**不依据记忆假定**。

集成分工提醒：CLI 调用发生在**安装/配置阶段**（`install.ps1` / `install.sh`）；日常工作流只依赖 OpenClaw 原生 Agent、原生工具、文件与本地 Git。

## 2. 探测事实（OBSERVED，来源 artifacts/preflight）

`artifacts/preflight/index.tsv` 记录了每条只读探测命令的退出码与时间。关键结论：

- `openclaw --version` → `OpenClaw 2026.7.1-2 (0790d9f)`，exit 0。
- `openclaw config validate --json` → **exit 0**。
- `openclaw doctor --lint --json` → **exit 1**。这是**用户环境既有的 lint 提示**；本项目**不修复、不执行 `doctor --fix`**（仅记录退出码）。
- `git` / `pwsh` / `bash` / `node` / `npm` / `python` / `py --version` 均记录在案（`node`/`npm`/`python`/`py` 仅记录，不作为本系统运行时必需依赖）。

## 3. `openclaw agents add` —— 注册原生 Agent

`agents add --help`（OBSERVED）语义：

```text
Usage: openclaw agents add [options] [name]
  --agent-dir <dir>             Agent state directory for this agent
  --bind <channel[:accountId]>  Route channel binding (repeatable) (default: [])
  --json                        Output JSON summary (default: false)
  --model <id>                  Model id for this agent
  --non-interactive             Disable prompts; requires --workspace (default: false)
  --workspace <dir>             Workspace directory for the new agent
```

本项目创建每个 Agent 的实际语义（绝对路径示例，`runtime_root_abs = D:\MicroConnect\project\openclaw-multi-agent\runtime`）：

```powershell
openclaw agents add manager-agent `
  --non-interactive `
  --workspace "D:\MicroConnect\project\openclaw-multi-agent\runtime\agents\manager-agent\workspace" `
  --agent-dir "D:\MicroConnect\project\openclaw-multi-agent\runtime\agents\manager-agent\state" `
  --model "<MODEL_IF_PROVIDED>" `
  --json
```

要点：

- `--workspace` 与 `--agent-dir` **必须是规范化后的绝对路径**，禁止相对路径。
- `--non-interactive` **需要** `--workspace`（否则报错）。
- `--model` 可选；缺省时继承默认。
- `--json` 输出机器可读摘要，便于安装脚本解析。
- `--bind <channel[:accountId]>` 可重复；**只**用于 `manager-agent`（由安装参数控制），工作 Agent 和生成 Agent 默认不配置用户渠道 binding。
- 幂等：同名 Agent 已存在且兼容（`workspace` 相同）则跳过；`workspace` 不同则安装停止，**不覆盖用户已有 Agent**。

## 4. `openclaw agents` 子命令（OBSERVED）

```text
add · bind · bindings · delete · list · set-identity · unbind
```

本项目使用：`add`（创建）、`list`（复核）、`bind`（可选，仅 manager 的用户渠道）。普通安装同步不使用 `delete`；只有生成组件删除流程在用户独立审批且通过 generated 边界校验后调用 `agents delete`。安装校验读取 `agents list --json`，确认所有 managed Agent 的 `workspace` / `agentDir` 均为绝对路径。

## 5. `openclaw config set` —— bracket 路径精确改字段

`config set --help`（OBSERVED）：`Usage: openclaw config set [options] [path] [value]`；`path` 支持 **dot 或 bracket notation**；`value` 为 JSON/JSON5 或 raw string。关键选项：

| 选项 | 含义 |
|------|------|
| `--strict-json` | 严格 JSON 解析（出错即报错，不回退为 raw string） |
| `--json` | `--strict-json` 的**旧别名**（legacy alias） |
| `--dry-run` | 只校验不写入 `openclaw.json` |
| `--merge` | 合并 object/map 值，而非替换目标路径 |
| `--replace` | 允许对受保护的 map/list 路径（如 `agents.defaults.models`）整体替换 |
| `--batch-file` / `--batch-json` | 批量 set 操作 |

**定位数组元素**：`agents.list` 是数组，**不得盲目整体替换**。做法是先读真实列表按 ID 找到索引，再用 bracket 路径改该元素的字段：

```powershell
# 1) 读取真实列表并按 id 找到索引 idx（不整体替换数组）
openclaw config get agents.list --json

# 2) 仅修改该元素的 subagents 字段（先 dry-run，再写入）
openclaw config set "agents.list[3].subagents" '{"delegationMode":"prefer","requireAgentId":true,"allowAgents":["requirement-agent","architect-agent","developer-agent","review-agent","test-agent","release-agent"]}' --strict-json --dry-run
openclaw config set "agents.list[3].subagents" '{"delegationMode":"prefer","requireAgentId":true,"allowAgents":["requirement-agent","architect-agent","developer-agent","review-agent","test-agent","release-agent"]}' --strict-json
```

流程铁律：**先 `--dry-run`，再 apply，再 `openclaw config validate --json`**；失败则恢复配置备份并列出可能残留的本项目目录。

## 6. `config get` / `config file` / `config schema` / `config validate`（OBSERVED 均存在）

- `openclaw config get <path> --json`：读取配置片段（用于定位 `agents.list` 索引、复核写入结果）。
- `openclaw config file`：打印配置文件绝对位置（本机为 `~\.openclaw\openclaw.json`）。
- `openclaw config schema`：打印当前版本 config schema（本项目所有字段名以此为准）。
- `openclaw config validate --json`：校验配置（本机 exit 0）。

## 7. `agents.list[]` 相关 schema 字段（OBSERVED，来源 config schema）

每个 `agents.list[]` 项包含（本项目会写入/依赖的字段）：

- `workspace`（string）—— 绝对路径。
- `agentDir`（string）—— 绝对路径。
- `subagents`：
  - `delegationMode`：`"suggest" | "prefer"`（schema 描述：`"prefer"` 强指示主 Agent 通过 `sessions_spawn` 委派）。
  - `allowAgents`：string[]（可派生的子 Agent 白名单）。
  - `requireAgentId`：bool（要求派发时显式指定 `agentId`）。
- `sandbox`：
  - `mode`：`"off" | "non-main" | "all"`。

本项目的目标配置：

| Agent | `subagents.allowAgents` | `subagents.requireAgentId` | `subagents.delegationMode` | `sandbox.mode` |
|-------|--------------------------|-----------------------------|------------------------------|-----------------|
| `manager-agent` | active/callable package 自动集合 | `true` | `prefer` | （不特设） |
| 工作 Agent | `[]`（默认禁止再派生） | — | — | package 可声明 |
| `test-agent`（额外） | `[]` | — | — | `off`（显式声明本阶段无沙箱） |

> 若当前版本不支持等价的 `sandbox.mode=off`，安装**必须停止**并在 `docs/compatibility-report.md` 说明，不得静默继承可能启用 sandbox 的全局默认值。

## 8. 跨 Agent 会话工具（manager-agent 独有）

会话作用域与门控字段均来自 config schema（OBSERVED）：

- 会话作用域 `scope`：`"self" | "tree" | "agent" | "all"`，控制 `sessions_list` / `sessions_history` / `sessions_send` 可定向的会话范围。schema 描述：`"tree"`（默认）= 当前会话 + 其派生的子会话；`"self"` = 仅当前；`"agent"` = 当前 agentId 下任意会话；`"all"` = 任意会话；**跨 agent 仍需 `tools.agentToAgent`**。
- `tools.agentToAgent`（含 `maxPingPongTurns`）：允许跨 Agent 交换的门控。
- `sessions_spawn`：schema 中存在；`delegationMode="prefer"` 的描述明确提到通过 `sessions_spawn` 委派。

`manager-agent` 调度依赖的原生会话工具（详见 `agents/manager-agent/workspace/TOOLS.md`）：

- `sessions_spawn` —— 创建隔离的工作 Agent 会话；**必须显式传 `agentId`**，且 `agentId == task.assigned_agent`；上下文用 `isolated` 语义（干净子会话，不 fork manager 私有历史）。
- `sessions_send` —— 向已建会话发送派发消息/追加指令。
- `sessions_list` —— 列出/定位子会话。
- `sessions_history` —— 读取子会话产出的公告/结果引用（仅用于确认完成，**不替代**对文件与 Git 的独立校验）。

> 兼容性：若本版本工具名/参数与上述不同，以真实 `--help` / `config schema` / 运行时工具 schema 为准调整调用，并在 `docs/compatibility-report.md` 记录差异；**不得**退回相对路径，**不得**引入 Python 控制层。

## 9. 本项目依赖的原生工具清单

| 类别 | 用途 | 边界 |
|------|------|------|
| 跨 Agent 会话工具 | `manager-agent` 调度 active/callable Agent | 仅 manager 可用；工作 Agent 默认 `allowAgents=[]` 不得再 spawn |
| 文件工具 | 读写控制层文件、任务上下文包、读工作 Agent `output/` | 路径必须绝对；工作 Agent 只写本 run `output/`、`raw-logs/` 与被分配 worktree |
| Shell 工具 | 生成 UUID、算 SHA-256、执行 Git 校验/合并、只读探测 | 显式绝对 cwd；关键命令落盘真实日志；默认禁网络/安装/破坏性命令 |
| Git 工具（仅本地） | 分支、绝对路径 worktree、commit/ancestry/diff 校验、`--no-ff` 合并 | 禁止 push/pull/fetch/remote；禁止 `reset --hard`/`clean -fdx`；不改全局 Git 配置 |

原生辅助命令（**不引入 Python**）：

- UUID：Windows `pwsh -NoProfile -Command "[guid]::NewGuid().Guid"`；POSIX `uuidgen`。
- SHA-256：Windows `Get-FileHash -Algorithm SHA256`；POSIX `sha256sum` / `shasum -a 256`。

## 10. 安装后配置校验命令

```powershell
openclaw agents list --json
openclaw agents bindings          # 若当前版本支持
openclaw config get agents.list --json
openclaw config validate --json    # 期望 exit 0
openclaw doctor --lint --json      # 仅记录退出码；本机 exit 1；不 --fix
```

以上命令的真实 stdout/stderr/退出码由安装/验证脚本保存到 `artifacts/`，并写入 `install-manifest.json` 的 `validation` 字段。
