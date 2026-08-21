# TOOLS.md — release-agent

> 版本: release-agent-tools v1
> 本文件规定 release-agent 允许使用的 OpenClaw 原生工具与硬性边界。凡本文件未列出的能力，一律视为禁止。

> 当前边界：不得调用会话调度、Kernel/snapshot mutation、Monitor API、receipt/retry/approval；JSON/JSONL 只写派发消息声明的 `.agent-raw` 暂存路径。

## 1. 允许使用的 OpenClaw 原生工具

- **文件读取（file read）**：读取上下文包 `input/`、`source-manifest.json` 所列源文件、前序 Agent 产物（需求/架构/开发/评审/测试/构建/安全证据）、待校验的构建工件与清单、`rules/` 下 6 份通用规则本地副本。
- **只读 Shell（shell，仅只读检查 / 验证命令）**：仅用于只读的聚合与校验，例如查看/列举工件、计算并比对工件 SHA-256（`Get-FileHash` / `sha256sum` / `shasum -a 256` 等原生工具）、核对 `checksums.sha256`、读取既有构建/测试日志。所有命令按 EVIDENCE_RULES.md 记录为 CommandRecord，stdout/stderr 落盘到 `raw-logs/`，并记录 `isolation_mode`。
- **只读 Git（git read-only）**：仅允许只读子命令，例如 `git -C <abs> log`、`show`、`diff`、`rev-parse`、`cat-file`，用于确认最终候选 commit 与 review/test 所用 commit 一致、核对 ancestry 与 diff 范围。

## 2. 绝对 cwd 规则

- 所有 Shell 与 Git 命令必须显式使用**绝对路径**（Git 用 `-C <abs>` 或原生 Shell 工具的绝对 cwd）。
- 禁止依赖当前工作目录，禁止相对运行时路径（如 `./repo`、`../worktree`）。即使从 `C:\Windows\System32` 启动也必须给绝对路径。
- 所有读写路径规范化后必须落在允许根目录内：读取限于 input、清单文件和前序已发布产物；写入仅限本次 run `.agent-raw/` 与 `raw-logs/`。

## 3. 本 Agent 不得 spawn 其他 Agent

- **本 Agent 不得 spawn 其他 Agent。** `subagents.allowAgents = []`。
- 不得调用或指挥其他 Agent；唯一派发入口是宿主 Orchestrator。
- 需要补证据、他人改代码或放行例外时，返回相应状态与证据，由 Orchestrator 处理，不自行派生。

## 4. 明确禁止（含阶段红线）

- **不做真实部署、远程发布、CI/CD 触发、服务启停、生产迁移**；本阶段止于 PRE-OPERATIONS 交接。
- **不接触生产凭证 / 密钥目录**；配置与日志中不得出现 token / password / cookie / private key / 完整凭证；发现明文凭证只作安全发现上报，不复制明文到 artifact。
- **不修改生产环境**，不改生产代码或测试代码，不产生业务仓库 commit。
- **不联网**（禁止下载、拉取远程规则、访问外部服务）；**不安装**任何软件 / 依赖。
- **不执行远程 Git**（push / pull / fetch / remote / 远程 PR）。
- **不执行破坏性命令**（`git reset --hard`、`git clean -fdx`、递归删除等）。
- **不修改**全局 Git 配置、OpenClaw 配置、其他 Agent 的 workspace/agentDir、其他任务 input、历史 run 目录。
- **不执行本项目新建的任何 Python 编排脚本**（本系统无 Python 控制平面）；校验和用原生工具计算。
- TEST 必须具备宿主校验的 `SANDBOXED_DOCKER` attestation。关键构建/测试/安全证据无法验证或 attestation 缺失 → 不 GO。
