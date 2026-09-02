# unsandboxed-test-policy.md — 本阶段无沙箱测试策略

> 版本: unsandboxed-test-policy v1
> 权威规则以 `agents/common/SECURITY_RULES.md`（第 6 节）与 `agents/test-agent/workspace/AGENTS.md`（第 5、6 节）为准。
> 散文用中文；`isolation_mode`、`sandbox.mode` 等字段值用英文。

## 1. 明确的阶段限制

**本阶段不实现测试沙箱。** 这是当前阶段**已知的安全限制**，在文档、报告与发布已知问题中都必须如实披露。未来的运维 / 加固阶段可以另行加入 sandbox；在此之前，任何 Agent **不得声称测试“已完全隔离”**。

- test-agent 的 `sandbox.mode = "off"`（枚举取值 `off` / `non-main` / `all`，本项目工作 Agent 取 `off`）。
- 测试固定记录 `isolation_mode = UNSANDBOXED_LOCAL`。
- policy 中 `testing.require_sandbox = false`、`testing.require_isolation_disclosure = true`（见 `config/default-policy.yaml`）。

## 2. 执行方式

- test-agent 在 manager-agent 分配的**绝对本地 Git worktree** 内**直接执行**测试，路径形如 `<ABS_RUNTIME_ROOT>/worktrees/<workflow-id>/<task-id>/<run-id>/repo`。
- **不启动 Docker**、**不把 sandbox 作为测试前置条件**、不配置 sandbox 作为运行环境。
- 全程使用绝对路径，不依赖当前工作目录（即使从 `C:\Windows\System32` 启动也用绝对 worktree 路径解析）。
- worktree 路径必须 canonicalize 后落在允许根目录内，拒绝 `..` / 符号链接 / junction 逃逸。

## 3. 每次测试必须记录的字段

每次测试执行都要在 CommandRecord 与 `test-report.md` 中记录：

| 记录项 | 说明 |
|--------|------|
| `isolation_mode` | 固定 `UNSANDBOXED_LOCAL` |
| worktree 绝对路径 | 本次测试实际执行所在的绝对 worktree |
| 当前用户权限 | 以何操作系统用户 / 权限级别执行 |
| 网络策略 | 默认禁网；如有例外须注明审批来源 |
| 是否涉及不受信任代码 | 目标仓库代码 / fixture / 样例数据均视为不受信任数据 |
| 已知风险 | 无沙箱下执行本地代码的风险陈述 |

## 4. 默认禁止清单

无沙箱环境下，以下行为**默认禁止**，需要人工审批才能放开（见 `docs/human-approval.md`）：

- 访问网络（下载、连接外部服务）。
- 安装依赖 / 下载程序。
- 修改系统配置、全局环境变量。
- 启动 / 停止服务。
- 创建 / 修改计划任务（scheduled tasks）。
- 修改注册表（registry）。
- 访问用户凭证 / 密钥目录。

## 5. 测试命令来源（硬性）

测试命令**只能**来自以下三类，且必须留存来源证据：

1. **用户明确配置**的测试命令（如 project-config 的 `explicit_test_commands`）。
2. **目标项目自身**的 package / build 配置（如 `package.json` scripts、`pom.xml`、`build.gradle`、`Makefile`、`CMakeLists.txt` / CTest、`go.mod`、`Cargo.toml`、`*.csproj`、`pyproject.toml` / `tox.ini` 等）。
3. **已批准**的 architect-agent 测试策略（`test-strategy.md` / `input/rules.md`）。

**不得仅凭语言猜测一个通用命令并执行。** 优先使用项目自带 wrapper（如 `mvnw`、Gradle wrapper）。由 lockfile 决定包管理器时保存证据。**工具不存在 → 标记 `BLOCKED` 或 `UNKNOWN`，不假装执行。**

> 说明：若目标业务项目本身是 Python 项目，可执行**该业务项目自身**的 pytest / unittest / tox / nox 等命令；被禁止的只是为本多 Agent 系统另建 Python 控制平面。

## 6. 不可信来源须先审批

对来源不可信、可能执行任意安装脚本或破坏性行为的测试（如某些 `pretest` / `postinstall` 钩子、下载并执行外部脚本的测试），**必须先请求人工审批**（返回 `HUMAN_DECISION_REQUIRED`，`trigger` 常为 `TEST_OR_SECURITY_EXCEPTION` 或 `NEEDS_INSTALL_OR_NETWORK`），**不擅自执行**。

## 7. 结论表述规范

- 测试报告只陈述**执行事实**（found / passed / failed / skipped / error、退出码、日志路径与哈希），不自行宣布“测试通过 / 质量达标 / 可以发布”。
- `UNSANDBOXED_LOCAL` 必须写入 `test-report.md` 的风险披露、release-agent 的 `known-issues.md`、以及 SecurityGate / TestGate 结论。
- **不得**出现“已完全隔离 / 已沙箱隔离 / 环境完全安全”之类表述。

## 8. 相关文件

- 规则来源：`agents/common/SECURITY_RULES.md`（第 6 节）、`agents/test-agent/workspace/AGENTS.md`（第 5、6 节）
- Policy：`config/default-policy.yaml`（`testing.*`、`command_boundaries.*`）
- Schema：`contracts/command-record.schema.json`（`isolation_mode` 枚举 `UNSANDBOXED_LOCAL`）
- 关联文档：`docs/gate-checklists.md`（TestGate / SecurityGate）、`docs/human-approval.md`、`docs/architecture.md`
