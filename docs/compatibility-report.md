# compatibility-report.md — OpenClaw 兼容性核对（据实）

> 版本: compatibility-report v1
> 本报告只记录**已探测**事实。所有结论均指向 `artifacts\preflight\` 下的原始文件（每命令有 `.stdout.txt` / `.stderr.txt` / `.meta.txt`，另有 `index.tsv`）。**未探测的内容一律标 `UNVERIFIED`，不虚构。**
> 散文用中文；命令、字段、枚举值、版本号用英文。
> **有效期提示（2026-08-17 补注）**：本报告是 2026-07-23 单次探测的固定快照，不会随环境自动更新。若本机 Node/OpenClaw CLI 版本已变化（例如 2026-08-17 复核时发现本机 Node 版本已不满足 OpenClaw CLI 的最低要求，导致 `openclaw --version` 无法执行），本报告中的版本号和退出码不再代表当前真实环境，需重新运行 `scripts/preflight-probe.sh` 探测。

> **当前架构说明（2026-08-22）**：当前架构是 Manager request queue → Node Orchestrator → SQLite Control Kernel。下文关于 CLI/schema 的 OBSERVED 结论仍是固定探测证据，但当时“Manager 原生派发、test-agent `sandbox.mode=off`”的项目目标已经被取代，不能作为当前配置指南。当前配置见 `config/openclaw-config-notes.md` 和 `docs/native-openclaw-integration.md`。

## 1. 探测环境与方法

- 探测脚本：`scripts/preflight-probe.sh`。
- 探测时的 `cwd`（见 `index.tsv`）：`/d/MicroConnect/project/openclaw-multi-agent`。
- 探测时间：约 `2026-07-23T08:32Z`（见各 `.meta.txt` 与 `index.tsv`）。
- 每条命令均保留 stdout / stderr 原始文件与 meta；退出码见 `index.tsv`。

## 2. OpenClaw 版本（OBSERVED）

- `openclaw --version` = `OpenClaw 2026.7.1-2 (0790d9f)`（exit_code 0）。
- 证据：`artifacts\preflight\openclaw-version.stdout.txt`、`artifacts\preflight\openclaw-version.meta.txt`。
- 多个子命令 `--help` 的头部横幅同样显示 `OpenClaw 2026.7.1-2 (0790d9f)`，与版本一致。

## 3. CLI 核对结果（OBSERVED，退出码见 index.tsv）

| 命令 | exit_code | 原始文件（slug） |
|------|-----------|------------------|
| `openclaw --version` | 0 | `openclaw-version` |
| `openclaw --help` | 0 | `openclaw-help` |
| `openclaw agents --help` | 0 | `openclaw-agents-help` |
| `openclaw agents add --help` | 0 | `openclaw-agents-add-help` |
| `openclaw agents list --help` | 0 | `openclaw-agents-list-help` |
| `openclaw config --help` | 0 | `openclaw-config-help` |
| `openclaw config get --help` | 0 | `openclaw-config-get-help` |
| `openclaw config set --help` | 0 | `openclaw-config-set-help` |
| `openclaw config patch --help` | 0 | `openclaw-config-patch-help` |
| `openclaw config file` | 0 | `openclaw-config-file` |
| `openclaw config schema` | 0 | `openclaw-config-schema` |
| `openclaw config validate --json` | 0 | `openclaw-config-validate` |
| `openclaw doctor --lint --json` | **1** | `openclaw-doctor-lint` |

> 说明：以上 `agents add` / `agents list` / `config set` / `config patch` 均为 `--help` 探测，**未实际添加 Agent 或写入配置**。本报告不声称执行过任何变更类命令。

### 3.1 `openclaw agents add` 支持的参数（OBSERVED）

来源：`artifacts\preflight\openclaw-agents-add-help.stdout.txt`。已核对存在以下选项：

- `--workspace <dir>`、`--agent-dir <dir>`、`--model <id>`、`--non-interactive`、`--json`、`--bind <channel[:accountId]>`（可重复）。
- `--non-interactive` 需要配合 `--workspace`。

与本项目预期一致：为 7 个 Agent 分配各自**绝对** `--workspace` 与 `--agent-dir`。

### 3.2 `openclaw config set` 支持的能力（OBSERVED）

来源：`artifacts\preflight\openclaw-config-set-help.stdout.txt`。已核对：

- 路径支持 **dot 与 bracket 两种记法**（"Config path (dot or bracket notation)"）。
- 支持 `--strict-json`、`--dry-run`、`--merge`、`--replace`。
- `--json` 为 `--strict-json` 的 **legacy alias**（"Legacy alias for --strict-json"）。

## 4. 配置 Schema 核对（OBSERVED）

来源：`artifacts\preflight\openclaw-config-schema.stdout.txt`（`openclaw config schema`，exit_code 0）。已核对以下字段确实存在：

- `subagents` 对象：
  - `delegationMode`：enum `["suggest", "prefer"]`。
  - `allowAgents`：`array` of `string`。
  - `requireAgentId`：`boolean`。
  - 在 `agents.defaults.subagents` 与 `agents.list[].subagents` 两处均存在。
- `sandbox` 对象：
  - `mode`：取值 `off` / `non-main` / `all`（schema 用 anyOf + const 表达）。
  - 在 `agents.defaults.sandbox` 与 `agents.list[].sandbox` 两处均存在。
- `agents.list[]` 条目含 `workspace`（string）与 `agentDir`（string）。

这些字段在探测版本中存在。当前项目使用所有 Agent 的空 `subagents.allowAgents`，Manager 由 Node Orchestrator 间接派发；Manager 与 test-agent 均使用 package 定义的 Docker `sandbox.mode=all`。每个 Agent 继续使用绝对 `workspace` / `agentDir`。

## 5. `config validate` 与 `doctor --lint`

### 5.1 `openclaw config validate --json` = 0（OBSERVED）

- 证据：`artifacts\preflight\openclaw-config-validate.meta.txt`（`exit_code=0`）、`.stdout.txt`。

### 5.2 `openclaw doctor --lint --json` = 1（OBSERVED，用户环境既有提示，不修复）

- 证据：`artifacts\preflight\openclaw-doctor-lint.meta.txt`（`exit_code=1`）、`.stdout.txt`。
- stdout 摘要（据实）：`ok=false`、`checksRun=88`、`checksSkipped=27`，findings 包含：
  - `core/doctor/security` 若干 `warning`：`openclaw.json` 存在明文 secret 字段（路径 `gateway.auth.token`），建议迁移到 SecretRefs。
  - `policy/policy-jsonc-missing` `warning`：`policy.jsonc` 缺失。
- 处置立场：这是**用户环境既有提示**，属用户既有配置状态。**本项目不执行 `openclaw doctor --fix`，不修复、不改动用户配置**（见 `agents/common/SECURITY_RULES.md` 第 1 节）。本报告仅如实记录 findings 的**路径名与类别**，不复制任何凭证明文（stdout 中亦未包含 token 值）。

## 6. 运行时无关工具（仅记录，非本系统运行时依赖）

以下为探测记录，退出码均为 0；其中 **node / npm / python / py 仅记录，不作为本系统运行时依赖**（本系统无 Python 控制平面）：

| 工具 | 版本（OBSERVED） | 原始文件（slug） |
|------|------------------|------------------|
| `git --version` | `git version 2.51.2.windows.1` | `git-version` |
| `pwsh --version` | `PowerShell 7.6.4` | `pwsh-version` |
| `bash --version` | `GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)` | `bash-version` |
| `node --version` | `v24.18.0`（非运行时依赖） | `node-version` |
| `npm --version` | `11.16.0`（非运行时依赖） | `npm-version` |
| `python --version` | `Python 3.12.6`（非运行时依赖） | `python-version` |
| `py --version` | `Python 3.12.6`（非运行时依赖） | `py-version` |

## 7. 示例工具名与真实版本的差异

对照本项目文档 / 配置示例中引用的 CLI 与字段：

- `openclaw agents add` 参数（`--workspace` / `--agent-dir` / `--model` / `--non-interactive` / `--json` / `--bind`）：**无差异**（第 3.1 节已核对存在）。
- `openclaw config set` 的 dot / bracket 路径、`--strict-json` / `--dry-run` / `--merge` / `--replace`：**无差异**（第 3.2 节已核对存在）。
- schema 字段 `subagents.{delegationMode, allowAgents, requireAgentId}`、`sandbox.mode`（`off` / `non-main` / `all`）、`workspace`、`agentDir`：探测时**无字段差异**（第 4 节已核对存在）；当前取值必须以 package manifest 和活动配置为准。

结论：就**已探测**范围而言，本项目示例引用的工具名与字段与真实版本 `2026.7.1-2 (0790d9f)` **无差异**。

## 8. 未验证项（UNVERIFIED，未探测，不虚构）

以下项目**未在 preflight 中探测**，标记 `UNVERIFIED`，不得据此下结论；需要时应另行探测并补记原始文件：

- 原生会话工具的确切名称与参数在本次快照中仍为 **UNVERIFIED**；当前 Manager 不依赖这些工具派发，因此不构成运行前置。
- `openclaw secrets configure` / `secrets apply` / `secrets audit --check` 的接口：**UNVERIFIED**（仅出现在 doctor 提示文案中，未独立探测）。
- `openclaw config get` / `config patch` / `config file` 的完整行为：仅探测了 `--help` 与（`config file`）单次调用退出码，**具体输出语义 UNVERIFIED**。
- `openclaw agents add` / `agents list` 的实际执行效果：**UNVERIFIED**（仅探测 `--help`，未实际执行变更）。

## 9. 相关文件

- 原始证据目录：`artifacts\preflight\`（`index.tsv` + 各命令的 `.stdout.txt` / `.stderr.txt` / `.meta.txt`）
- 探测脚本：`scripts/preflight-probe.sh`
- 关联文档：`README.md`（安装/校验入口）、`docs/evidence-and-claims.md`
