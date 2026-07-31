# 真实 Agent JSON 测试 Harness 实施计划

> **面向 Agent 执行者：** 在当前工作区内联执行。用户明确授权使用这个包含未提交参考文件的工作区；不要创建 worktree、提交，或触及无关改动。

**目标：** 使用真实已注册 OpenClaw Agent 覆盖项目的每份 JSON/JSONL 契约；每个不合法产物由真实 Agent 重写一次，并保留所有重写后仍失败的产物供审阅。

**架构：** 场景规划器为 19 份 Schema 各生成 30 条不同的自然语言需求。执行器为每个用例写入输入和上下文，通过 `openclaw agent` 调用映射角色，并且只使用 `scripts/runtime-guard.mjs validate-file` 校验 Agent 写出的产物。首次失败时，在同一隔离会话中额外调用一次真实 Agent 重写。收集器写入可追加的完整运行目录和精简的最终失败报告。

**技术栈：** Node.js ESM、Node 内置文件系统/进程 API、已安装的 OpenClaw CLI、现有基于 Ajv 的 Runtime Guard。

## 全局约束

- 每个待测产物必须由真实 OpenClaw Agent 写入；执行器不得构造、修复或变更待验 JSON/JSONL。
- 覆盖 `contracts/` 中全部 19 份 Schema，每份至少 30 条不同用例。
- 模板仅可用于理解字段语义；生成的 ID、路径、时间、主题、语言、状态和数据组合必须不同于已发布模板。
- 校验只能经由 `scripts/runtime-guard.mjs validate-file` 完成。
- 首次校验失败时，仅向同一真实 Agent 会话发起一次 JSON-only 重写；Node 不得修复输出。
- 每个重写后仍失败的用例必须打包两次输出和两次校验报告；不得按场景截断数量。
- 人工只阅读最终 `summary.json` 与 `report.md`；实现者和审阅者不得阅读正常产物。

---

### 任务 1：定义真实运行场景与文件系统契约

**文件：**

- 新建：`scripts/agent-json-harness/real-scenarios.mjs`
- 新建：`tests/real-agent-json-harness.test.mjs`

**接口：**

- 产出 `REAL_SCENARIOS`，每项包含 `{ name, schemaFile, jsonl, agentId, artifactFileName, buildCases() }`。
- 为每份 Schema 产出至少 30 条不同提示/数据上下文，并精确覆盖 19 个场景。

- [ ] 编写失败测试：断言 19 份契约 Schema 均被覆盖、每份有 30 个唯一 case ID，且生成提示不含完整拷贝的模板 payload。
- [ ] 运行 `node --test tests/real-agent-json-harness.test.mjs`，确认因场景模块不存在而失败。
- [ ] 实现 Schema 到角色的映射，以及确定性但差异化的用例/提示生成。
- [ ] 重新运行测试并确认通过。

### 任务 2：实现真实 OpenClaw 调用与重试状态机

**文件：**

- 新建：`scripts/agent-json-harness/real-runner.mjs`
- 修改：`tests/real-agent-json-harness.test.mjs`

**接口：**

- 暴露 `runCase(casePlan, options)`，返回不可变的尝试元数据、原始回复路径、产物路径和 Guard 报告。
- 调用 `openclaw agent --agent <agentId> --session-key <unique-session> --message-file <prompt> --json`；不得使用 `--local` 或模型覆盖。
- 通过已有 `guard.mjs` 的生产包装调用 `validate-file`。

- [ ] 使用临时假 OpenClaw 可执行文件编写失败测试，证明首轮通过不重试、首轮失败仅用同一 session key 再调用一次。
- [ ] 运行聚焦测试，确认因执行器不存在而失败。
- [ ] 实现输入/上下文创建、命令超时与错误捕获、真实 Agent 命令构造、产物发现、Guard 校验和一次重试状态转换。
- [ ] 重新运行聚焦测试并确认通过。

### 任务 3：实现完整的重写后失败收集器

**文件：**

- 新建：`scripts/agent-json-harness/collect-real-failures.mjs`
- 修改：`tests/real-agent-json-harness.test.mjs`

**接口：**

- CLI 参数：`--run-id`、`--scenario`、`--resume`、`--timeout-seconds`、`--output-root`。
- 输出：`<output-root>/<run-id>/{summary.json,report.md,failures/<scenario>__<case>/...}`。
- 每个 `RETRY_FAILED` 目录均包含输入/上下文、两次产物（或明确的缺失标记）、原始回复、两次 Guard 报告、重试提示和元数据。

- [ ] 编写失败测试：用受控失败结果驱动收集器，断言不存在数量上限、两次尝试均被保留且 `report.md` 索引每个失败包。
- [ ] 在实现收集器前运行聚焦测试并确认失败。
- [ ] 实现每次运行的续跑账本、原子元数据写入、完整打包、汇总统计与报告渲染。
- [ ] 重新运行聚焦测试并确认通过。

### 任务 4：接入命令、保留有用离线检查并删除未使用重复文件

**文件：**

- 修改：`package.json`
- 修改：`tests/agent-interaction-json.test.mjs`
- 删除：根目录未跟踪文件名中以 `C:\\Users\\Andy\\...agent-json-harness\\collect-failures.mjs`、`...\\repair.mjs`、`...\\tests\\agent-interaction-json.test.mjs`、`C:\\Users\\Ryan\\...agent-json-harness\\{baselines,guard,scenarios}.mjs` 开头的文件。

- [ ] 编写失败的命令入口测试，或使用聚焦执行器测试证明文档中的真实命令解析到现有脚本，且旧的截断收集器不会被调用。
- [ ] 运行它并确认变更前命令路径不存在或错误。
- [ ] 增加分别用于确定性离线契约回归与全量真实 Agent 执行的命令；仅保留有用的共享 Guard/场景辅助模块。
- [ ] 精确删除未使用的 Windows 路径重复 Harness 文件，保留无关报告和探针文件。
- [ ] 重新运行单元测试并检查 `git status --short`，确认仅预期 Harness 路径发生修改或删除。

### 任务 5：沿真实生产路径验证，并且只审阅失败包

**文件：**

- 仅生成：`artifacts/agent-json-real/<run-id>/...`（必须保持未跟踪）

- [ ] 运行 `npm run test:agent-json:offline`。
- [ ] 运行 `npm run agent-json:real` 的默认全场景矩阵（570 次真实首轮调用，且每个失败输出最多一次重试）。
- [ ] 只读取生成的 `summary.json` 和 `report.md`，不读取单条正常产物。
- [ ] 运行项目相关回归测试：`npm run test:runtime-guard` 与 `node --test tests/validate-install.test.mjs`。
- [ ] 报告最终运行 ID、统计数字，以及最终报告引用的重写后失败项。
