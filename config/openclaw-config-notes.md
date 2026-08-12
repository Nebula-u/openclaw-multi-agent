# OpenClaw 配置说明（openclaw-config-notes.md）

本文件记录本项目**实际依赖**的 OpenClaw 配置字段与 CLI，全部以本机探测结果为准（见 `artifacts/preflight/` 与 `docs/compatibility-report.md`）。**不得凭记忆假设字段存在。**

探测版本：`OpenClaw 2026.7.1-2 (0790d9f)`
配置文件路径（`openclaw config file`）：`C:\Users\liuxu\.openclaw\openclaw.json`

## 1. 创建 Agent（`openclaw agents add`）

实测 `openclaw agents add --help` 提供的选项：

```
openclaw agents add [name]
  --workspace <dir>             # 本项目：必传绝对路径
  --agent-dir <dir>             # 本项目：必传绝对路径（agentDir/state）
  --model <id>                  # 可选
  --bind <channel[:accountId]>  # 可重复；工作 Agent 不绑定
  --non-interactive             # 需配合 --workspace
  --json                        # 输出 JSON 摘要
```

> `agents add` **没有** `--subagents` / `--sandbox` 选项。subagent 白名单与 sandbox 模式必须通过 `config set` / `config patch` 写入 `agents.list[*]`。

## 1.1 重新安装项目 Agent

实测卸载命令为 `openclaw agents delete <id> --force --json`。项目提供 `scripts/reinstall-agents.ps1`：它只在当前 `agents.list` 中的 workspace 和 agentDir 与 package manifest 计算出的 runtime 路径完全匹配时才调用 delete，并只重装当前已安装的项目 Agent；未安装 package 不会被自动注册。OpenClaw 返回配置乐观锁冲突时，脚本会刷新 `agents.list`，若目标实际已删除则视为成功。随后运行 `install.ps1 -Apply -AgentIds ...`，更新 `agents.list`、runtime workspace、install manifest 和 runtime bundle；未指定 `-ModelConfig` 时自动从备份恢复当前每 Agent 模型路由。它会先备份配置与项目 Agent 的 workspace/state 到 `runtime/control/reinstall-backups/`。

先预演，再执行：

```powershell
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -RuntimeRoot runtime
```

## 2. 配置读写（`openclaw config ...`）

- `openclaw config file` — 打印活动配置文件路径。
- `openclaw config schema` — 打印 openclaw.json 的 JSON Schema。
- `openclaw config get <dotpath> --json` — 读取。
- `openclaw config validate --json` — 校验（本机初始结果 `{"valid":true,"warnings":[]}`）。
- `openclaw config set <path> <value> [--dry-run] [--strict-json] [--merge] [--replace]` — 按路径写。`--replace` 才允许替换受保护的 map/list（如 `agents.defaults.models`）。
- `openclaw config patch --file <f>|--stdin [--dry-run] [--json] [--replace-path <p>]` — 一次性合并式写入：对象递归合并、数组/标量替换、null 删除。`--replace-path` 指定处按替换而非递归合并。

**本项目安装脚本统一使用 `config patch --dry-run --json`（先预演）→ 再 apply → 再 `config validate --json`。** 定位 `agents.list[index]` 时先 `config get agents.list --json`，按 `id` 查真实索引，再改该项字段。**不盲目替换整个 `agents.list` 数组。**

## 3. 本项目使用的 `agents.list[*]` 字段（实测 schema 存在）

```jsonc
{
  "id": "manager-agent",
  "name": "...",
  "workspace": "<ABS>",      // string
  "agentDir": "<ABS>",       // string
  "model": "...",            // string | { primary, fallbacks[] }
  "subagents": {
    "delegationMode": "prefer",   // "suggest" | "prefer"
    "allowAgents": ["requirement-agent", ...],  // 子 Agent 白名单
    "requireAgentId": true        // 要求派发时显式 agentId
  },
  "sandbox": {
    "mode": "off"            // "off" | "non-main" | "all"（本项目 test-agent 用 "off"）
  }
}
```

- **manager-agent**：`subagents.allowAgents` 由 package catalog 中 `register=true`、`active=true`、`callable_by_manager=true` 的工作 Agent 自动计算；`requireAgentId: true`；`delegationMode: "prefer"`。
- **工作 Agent**：默认 `subagents.allowAgents = []`（禁止再派生）；生成 Agent 也使用该默认值。
- **test-agent**：`sandbox.mode = "off"`（本阶段无沙箱的显式声明；不配置 Docker backend / mount / sandbox 网络）。

## 4. 原生跨 Agent 会话调度（实测存在于 schema / 工具面）

- 工具：`sessions_spawn`（创建隔离子 Agent 会话，可传 `agentId`）、`sessions_send`、`sessions_list`、`sessions_history`。
- 门控：`tools.agentToAgent`（含 `maxPingPongTurns`，0–20）控制跨 Agent 交换；per-agent `spawnSubagentSessions` 能力位。
- `sessions.threadBindings.defaultSpawnContext` = `isolated` | `fork`（本项目子任务用 `isolated` 语义：干净子会话）。

> 若未来版本工具名或参数不同，以实际 `--help` 与 `config schema` 为准，并在 `docs/compatibility-report.md` 记录差异。**不得退回相对路径，不得引入 Python 控制平面。**

## 5. Binding / 默认 Agent

- `openclaw agents bind` / `unbind` / `bindings` 管理路由绑定。
- 是否将 manager-agent 设为默认或绑定用户渠道，由安装参数（`-SetManagerAsDefault` / `-ManagerBinding`）显式控制，默认不改变既有路由。

## 6. 明确不做

- 不执行 `openclaw doctor --fix`。
- 不安装 Docker、不启用 sandbox 作为测试前置。
- 不删除/重置用户既有 Agent、认证、会话或 workspace。

## 7. 本轮工具结果预算

当前配置已设置 `agents.defaults.contextLimits.toolResultMaxChars = 12000`，限制单次 live tool result 注入上下文的字符数；工具本身仍可正常调用。需要完整内容时，Agent 必须使用目标查询、`offset/limit` 或分段读取，不得通过重复请求同一大结果来“补全”上下文。模型由 package 默认值或显式 `ModelConfig` 静态指定，Agent 不得自行切换。
