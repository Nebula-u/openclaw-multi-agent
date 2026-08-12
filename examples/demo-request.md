# demo-request.md — 示例用户需求（交给 manager-agent 的样例）

> 说明：这是一个**示例**用户需求，用于演示如何把一个需求交给 manager-agent。
> 真实使用时，manager-agent 会把用户原始消息保存到 `<workflow>/user-request.md` 作为唯一权威来源。
> 本示例中的路径为**绝对占位路径**，实际使用请替换为你本机的真实绝对路径。

---

## 需求标题

为本地命令行工具 `mycli` 新增一个子命令 `mycli greet`，并补充对应的单元测试与集成测试。

## 背景

`mycli` 是一个已存在的本地 CLI 工具，代码位于本机绝对路径下的 Git 仓库中。目前它已有若干子命令，现在希望新增一个 `greet` 子命令。

- 目标项目根目录（绝对路径占位）：`D:\work\mycli`
  - POSIX 环境示例：`/home/user/work/mycli`
- 目标项目为本地 Git 仓库，当前工作区应无未提交修改。

## 目标（Goal）

1. 新增子命令 `mycli greet`：
   - 用法：`mycli greet [--name <name>] [--lang <zh|en>]`。
   - 行为：打印一句问候语；默认 `--name world`、`--lang en`。
   - `--lang zh` 输出中文问候，`--lang en` 输出英文问候。
2. 为该子命令补充**单元测试**（参数解析、默认值、多语言分支）与**集成测试**（实际调用 CLI 并断言输出与退出码）。
3. 更新该子命令的帮助文本（`mycli greet --help`）。

## 约束（Constraints）

- **仅本地**完成：本地 Git、本地 worktree；**不联网、不安装新依赖、不改系统环境**。若确需联网 / 安装 / 凭证，请先走人工审批，不要擅自执行。
- **不做**真实部署 / 发布 / CI-CD 接入 / 服务启停 / 生产迁移（本阶段止于运维前交付）。
- 不修改与本子命令无关的既有功能与公共接口；如需变更公共 API 或数据格式，请先提审批。
- 测试命令**只能**来自本项目自身的 build / package 配置，或我在项目配置中显式给出的命令；**不要凭语言猜一个通用命令**。工具缺失时请标 `BLOCKED` / `UNKNOWN`，不要假装执行。
- 新 test-agent run **强制使用轻量级 Docker sandbox**（`isolation_mode = SANDBOXED_DOCKER`）；沙箱、动态挂载或 attestation 不可用时必须 `BLOCKED`，禁止宿主机回退。
- 所有改动形成**真实本地 Git commit**；不要执行破坏性 Git 命令（如 `git reset --hard`、`git clean -fdx`）。

## 验收期望（Acceptance Expectations）

1. `mycli greet` 存在且可运行：
   - `mycli greet` 输出英文默认问候，退出码为 0。
   - `mycli greet --name Alice --lang zh` 输出针对 `Alice` 的中文问候，退出码为 0。
   - `mycli greet --help` 显示新子命令的用法说明。
2. 新增测试**真实执行**且关键用例退出码为 0；测试报告包含 found / passed / failed / skipped / error 数量、退出码、日志路径与哈希。
3. 覆盖率若由项目现有工具真实产出则附带数据；否则相关结论标 `UNKNOWN`，不要编造覆盖率。
4. 提供从验收标准到测试用例的追踪（`test-traceability.json`）。
5. 变更范围仅限该子命令实现与其测试 / 帮助文本；diff 路径可复核。

## 交付物期望

- 目标仓库 worktree 内的真实 commit（含实现与测试）。
- 结构化结果与人类可读报告（需求 / 开发 / 评审 / 测试 / 发布就绪各阶段产物按流程生成）。
- 明确的 UNKNOWN / 风险 / 限制列表（含 sandbox attestation、Docker Engine 和真实 E2E 验证状态）。

## 备注

- 如需求存在关键歧义（例如多语言问候的确切文案、`--lang` 取值范围是否扩展），请先向我确认，不要自行假设后实现。
- 请在每个阶段结束时向我转述对应 Agent 的自然语言总结，并保留其中的 UNKNOWN 与风险说明。
