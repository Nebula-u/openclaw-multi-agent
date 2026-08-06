# 当前完成度评估

> 更新日期：2026-08-06
>
> 提交口径：`2026-07-29 00:00 +08:00` 至当前分支 HEAD 的 Git 历史。
> 证据口径：区分已提交实现、自动化验证、实际 OpenClaw 实机演练，以及仍待验收的后续计划。

## 结论

本周期完成了从“文件协议 + Runtime Guard 的基础框架”到“SQLite Control Kernel v2 的事务化控制面”的关键跃迁。7 个 Agent 的职责和 OpenClaw 原生 `sessions_spawn` 调度方式没有被替换；改变的是 Manager 可写状态、派发和验收的可信边界。

最直接的两项历史痛点已有针对性闭环：

- JSON 不再仅靠提示词约束。Schema、保守摄取、分类重写、真实模型 Harness、任务产物复检和失败证据共同组成 fail-closed 链路。
- workflow/task/dispatch 不再由多份可写 JSON 彼此同步。当前 v2 状态以 SQLite 事务、命令、事件链和 CAS 为唯一权威；JSON/JSONL 降为可删可重建的只读投影。

提交记录显示，P0–P8 的框架、自动化 E2E、并发与恢复测试均已完成。Monitor Control Kernel、宿主机原生 Supervisor Core、静态 HTML Dashboard、activity/tailer、health、watchdog shadow、wake adapter 和 controlled retry 已落地；但这不等同于生产运维完成：尚未以真实 OpenClaw Gateway 跑出一条新的完整 6 工作 Agent v2 workflow，真实 manager 自动唤醒仍关闭，Manager 编排整改计划仍有未完成验收项，且当前环境没有可用浏览器实例执行截图式视觉 QA。

## 7 月 29 日至 8 月 6 日的改动脉络

| 时间 | 主线改动 | 为什么改 | 已产生的效果 |
|---|---|---|---|
| 7/29 | 引入可信 Runtime Guard、版本化 workflow 状态机、工作流/事件/Gate/审批契约；补齐 release-review 血缘、当前 candidate Gate 权威和终态门禁。 | `active-workflows.json`、workflow 快照、事件与 Gate 曾能互相漂移，历史 Gate 甚至可能错误影响当前候选。 | 状态迁移、证据、锁归属、审批作用域和 Gate 聚合进入同一 fail-closed 校验边界；失败项、缺失审批或不可信 Gate 不能被文本“已完成”绕过。 |
| 7/30–7/31 | 补齐 Changelog；建立真实 Agent JSON Harness 的场景规划、执行、一次重写和失败包收集方案。 | 单元测试只能证明校验器，不能说明真实 Agent 在不同契约下实际会输出什么。 | 可对全部契约进行真实调用、同会话重写和失败留档；为后续模型与提示调优提供可复核样本。 |
| 8/3 | 强化 Guard 的上下文包、规则快照、任务依赖/汇总、审批评估、架构变更门禁、文件化恢复检查、损坏快照 HOLD、派发前 task package 检查及 `QUARANTINED` 终态；新增 LLM JSON Harness。 | 历史 workflow 有 manifest/输入哈希/路径/事件不一致，且 session 覆盖和超长上下文会导致模型路由误判、流断开或错误恢复。 | 不完整输入和损坏快照在派发前/恢复时失败关闭；无法可信恢复的历史流程可隔离；Manager 采用 80% 会话软预算并能从文件化状态恢复。 |
| 8/4 | 实现原子 workflow transaction kernel、task-run 与锁、dispatch lifecycle ledger、结构化产物声明与摄取；统一 DeepSeek V4 Pro 路由并增强 JSON/JSONL 恢复。 | 多文件先后写入会产生部分提交；任务可能先标记完成、后发现 result 缺失；模型常返回 BOM、fence、解释文字、截断或类型/枚举错误。 | 写入、事件和状态能以事务/账本追踪；派发前后与结果验收均有约束；已知 JSON 包装可确定性清理，未知/歧义内容不会被猜测性修复。 |
| 8/5 上午 | P0–P5 完成：运行时 bundle 防漂移、SQLite Control Kernel、投影恢复、task/dispatch/result 闭环、遗留 v1 取证隔离、并发/崩溃/E2E 测试与文档收口。 | Guard 只能检查边界，仍无法彻底消除多份可写状态和外部 spawn 的崩溃间隙。 | v2 以数据库为唯一当前事实；outbox、receipt、幂等与审计覆盖外部副作用和恢复；遗留不可信事件不会被伪造补链。 |
| 8/5 下午 | 重装 7 个受管理 Agent 并同步 runtime；将 DeepSeek 自定义路由的单次输出预算设为 49,152；记录 Manager 编排整改计划。 | 旧安装副本可能未加载新规则；长输出曾以 `stopReason: length` 截断。 | 已安装 bundle 与源码摘要一致，7 个项目 Agent 的路由恢复；验证探测确认不再受旧 8,192 输出上限截断。整改计划只完成立项，尚待按轮实施。 |

## JSON 格式问题：如何减轻、边界在哪里

### 发生原因

历史问题并不只是“模型偶尔输出错 JSON”：真实回复会带 BOM、唯一 Markdown fence 或解释文字，也会出现空内容、截断、JSONL 格式错误、enum/type 不合法、Schema drift，以及多个 JSON 候选。更危险的是，若 Manager 只从聊天文本判断成功，非法或缺失 `result.json` 仍可能推进 workflow。

### 已完成的分层措施

1. **先把契约变得可验证。** 7/29 增加 `json-validation-error` 契约和重写模板；随后强化 `task`、`result` 等核心 Schema，并为身份、状态、枚举和结构化产物关键字段补充 `description`。任务声明显式列出 `structured_outputs[]`，而不是默认“有一个 result 就算完成”。
2. **用真实调用而非想象验证。** 7/31 的真实 Agent Harness 和 8/3 的 Gateway LLM Harness 把场景、原始回复、Guard 报告、重试与失败摘要落盘。它们用于发现真实模型失败类型；离线测试保证重试/收集逻辑本身可回归。
3. **只处理确定无歧义的包装。** 8/4 的 ingestion 只移除 BOM、唯一 fence，或提取唯一解释性前后缀中的完整 JSON/JSONL；出现多个候选即拒绝。系统不会补字段、改类型、改枚举或改业务值，因此不会把猜测伪装成正确数据。
4. **按失败类型重写，而非泛化地“再试一次”。** 空输出、截断、enum/type、schema drift 使用固定诊断模板；首次调用之外最多再试两次，并保存原始/清洗 SHA-256 和转换元数据。失败后仍可追溯“模型原样输出了什么、系统仅做了什么清理”。
5. **把校验放到状态推进之前。** Guard 在派发前检查 task/context package；v2 的 `result-ingest` 校验 result 哈希、session 身份、任务锁定的全部 JSON/JSONL Schema、路径和产出 Agent。任一必需产物失败时，task 不会成为 `COMPLETED`。
6. **防止半写入制造格式问题。** 8/4 的 transaction/ledger 和 8/5 的 Kernel 将命令、状态、事件和 outbox 放进事务；后续整改计划还会把所有业务 JSON 写入统一为“内存 Schema 校验 → 序列化复解析 → 临时文件回读校验 → 原子替换”。后者截至本评估日仍是待实施项。

### 效果与剩余风险

格式类问题已从“异常文本可能推动流程”变成“可分类、可重试、可审计且默认阻断”。提交记录中的 P5 全量回归报告 Runtime Guard 105 项通过（另有 2 项 Windows 符号链接场景跳过）、Agent JSON 12 项通过；这证明框架逻辑，不代表真实模型永不输出错误 JSON。真实 Gateway 的全量跨 Agent 契约演练，以及长期失败率/截断率监控，仍是下一步验证重点。

## 状态机不匹配：如何解决

### 原问题

第一周的文件化实现里，`workflow.json`、`active-workflows.json`、任务文件、事件 JSONL 和 Gate 可以独立写入。实际遗留数据已出现典型漂移：`WF-a899188b...` 的可信事件只到 revision 13，snapshot 却写 revision 18，active index 停在 revision 7。另一个根因是把阶段和 `WAITING/HOLD` 混成单一枚举，恢复时无法知道该回到哪个阶段、哪个条件。

### 两阶段治理

**第一阶段：Guard 先封住错误入口（7/29–8/4）。** 版本化状态机和 Schema 限定合法边；Gate 必须来自当前 candidate，review/release 和锁/证据要绑定同一血缘；输入 package、规则快照、依赖、路径和结构化产物在边界复核。损坏状态转为结构化 `HOLD`，不能可信修复的流程进入 append-only `QUARANTINED`，而不是继续伪造状态。

**第二阶段：Control Kernel 消除多写源（8/5）。**

- SQLite 保存 workflow、task、run、dispatch 和 result 的当前状态；每个成功命令在同一事务中产生一个 revision、幂等结果和不可变哈希事件。
- 状态拆为正交的 `phase + condition + outcome`，并保存 `resume_phase/resume_condition`；`HOLD/WAITING` 恢复不再依赖 Manager 聊天记忆。
- 纯 reducer 按 `transition-command` 与版本化 `control-state-machine-v2.json` 计算下一状态；Manager 不再手算 revision 或分别覆盖状态文件。CAS 让同 workflow 并发只产生一个胜者。
- `active_workflows` 是数据库 view；workflow/events/active JSON/JSONL 经 projection outbox 生成，属于只读投影。投影被删或滞后时可在审计后重建，不能反向改写权威状态。
- 外部 `sessions_spawn` 无法与数据库同事务，因此先事务化记录 PENDING dispatch intent、task 状态和 outbox，再以 `SENT → ACKNOWLEDGED → RUNNING` receipt 对账。崩溃后查询 intent/session 恢复，而不是猜测是否已派发。
- v1 只做取证归档和 v2 tombstone；不补造缺失 revision，也不把不可信旧 candidate 带回 active view。

提交记录中的 P5 测试覆盖同 workflow CAS、跨 workflow active、提交前回滚、提交后响应丢失、投影失败恢复、spawn 前重启、completion exactly-once、数据库重启和删除投影后的确定性恢复。这是解决“状态机不匹配”的核心：从事后对齐多个文件，改为只允许一个事务权威源产生状态。

## 其他较大改动及效果

- **运行时防漂移与安装同步：** `runtime-bundle.mjs` 对 package workspace、规则、模板和 skill 生成摘要；Manager 恢复前验证安装副本与源码。历史直接覆盖 runtime 控制文件的 8 个脚本已禁用并移入取证目录。8/6 已完成受管理 7 Agent 的备份、重装、校验和原路由恢复；安装器同时修复了 OpenClaw 诊断输出和配置锁冲突兼容性。
- **任务、派发、结果三段式闭环：** task 注册锁定 contract set/output version；派发必须校验 context identity、输入哈希、依赖、Agent policy 和绝对路径；completion 必须闭合 run、session 和所有必需产物。它解决了“控制层显示完成、实际文件缺失”的断层。
- **遗留 v1 取证隔离：** 4 个旧 workflow 被复制、哈希、只读归档，再以 `QUARANTINED` tombstone 导入 v2；源目录未修改。这样既保留审计证据，也避免把无法证明正确的历史当作可恢复当前状态。
- **模型路由、会话预算与截断：** 先清理 Manager 会话级模型覆盖、设 80% 软预算与文件化恢复，再统一 7 Agent 到 DeepSeek V4 Pro Chat Completions。8/5 将明确 `maxTokens` 提升至 49,152，解决长 HTML 等输出被旧上限截断的问题。
- **跨平台与可观测性准备：** Bash/Windows 安装校验兼容性得到修复；8/4 增加轻量多 Agent 可观测与交互平台设计，8/5 增加编排/执行协议整改计划。二者目前都是计划资产，不应视为监控平台或编排整改已经上线。

## 第一周计划复盘（基础框架）

| 第一周目标 | 当前结论 | 已完成部分 | 剩余小问题与解决方向 |
|---|---|---|---|
| 项目初始化、目录、配置、OpenClaw 入口 | 完成 | package manifest、安装/校验、7 个 Agent 注册与 13 阶段 SDLC 骨架均已存在；8/5 还完成了 7 Agent 重装和 bundle 同步。 | 新 runtime 创建真实 workflow 前仍应复核 bundle 与已安装 Agent 一致。 |
| workflow/task 状态机 | 由“部分完成”提升为框架完成 | Guard 版状态机、v2 reducer、SQLite 事务、CAS、事件链、投影恢复、隔离迁移和恢复测试均已完成。 | 仍缺真实 Gateway 运行中断后的恢复演练；按 PENDING intent 查询原 session 后继续。 |
| Agent 角色和通信契约 | 完成并加强 | 7 角色职责未变；契约、结构化输出声明、输入包/规则快照和身份/路径校验已增强。 | 需要在真实 6 工作 Agent 链路验证每个角色都按当前 bundle 生效。 |
| 日志、过程追踪、事件证据 | 框架完成 | 不可变哈希事件、task/dispatch/outbox/audit、失败 JSON 包和遗留取证已具备。 | 外部 Gateway receipt 和真实会话中断证据尚未补齐。 |
| Pipeline、Gate、人工审批 | 核心机制完成 | Gate fail-closed、当前 candidate 权威、审批作用域、审批评估和架构变更门禁均已落地。 | 标准 SDLC 与轻量原型的 Intake 分流/不可绕过派发仍是下一轮编排整改项。 |
| 测试隔离 | 未完成 | 已明确 `UNSANDBOXED_LOCAL` 风险并保留审批边界。 | 将 `test-agent` 迁移至真正隔离环境；在此之前，限制命令、联网和依赖安装，并把风险写入 Gate。 |

## 第二周计划复盘（可信需求→架构→开发闭环）

| 第二周目标 | 当前结论 | 已完成部分 | 剩余小问题与解决方向 |
|---|---|---|---|
| Manager 最小闭环 | 自动化层完成，实机未完成 | v2 E2E 可走到 `READY_FOR_OPERATIONS_HANDOFF`，workflow/task/run/dispatch/result 均有 Kernel 边界。 | 用已同步 runtime 新建真实 workflow，真实调用 requirement、architect、developer、review、test、release，并保存 receipt/artifact。 |
| 上下文裁剪与 task package | 基本完成 | 上下文身份、规则快照、input hash、task package 和派发前检查均已落地；Manager 有 80% 软预算和恢复入口。 | 下一轮用 Intake 明确标准 SDLC/轻量原型，确保任何执行前都有 workflow/task/run。 |
| Developer Git 闭环 | 基础样例已有，v2 实机证据待补 | 第一周 Demo 有本地 branch/worktree/commit；v2 对路径、Agent policy、输入和结构化结果有更严校验。 | 在新的真实 v2 workflow 中重复验证真实 commit、允许范围 diff 和命令记录。 |
| Schema 强制校验 | 完成 | 任务、上下文、Gate、result 和声明的 JSON/JSONL 均有 Schema/Guard/Kernal ingestion 复检。 | 实施统一 JSON 原子写入，覆盖 package、receipt、result 和审计投影的落盘边界。 |
| 人工审批与需求/架构回路 | 核心机制完成 | approval assessment、架构变更 Gate、HOLD/恢复路径和审批作用域校验已实现。 | 将其接入不可绕过的真实派发编排，并用标准 SDLC 实机演练。 |
| 用量/模型路由 | 部分完成 | 已有模型路由文档、统一 DeepSeek V4 Pro、会话软预算、失败重写预算与 49,152 输出上限。 | 尚无每 run 的完整 token/cost 台账；下一轮把 usage/cost 与 run 事件关联，并监测截断/重试率。 |

## 当前难点与下周克服方式

1. **框架证据和真实运行证据仍有距离。** 下周优先在已同步 runtime 上执行一个全新、范围受控的 v2 workflow；保留 dispatch receipt、结构化产物、Gate 和 audit，并注入一次 manager/Gateway 中断验证恢复。
2. **最新 Manager 审计发现的旁路仍未代码化封死。** 8/5 的整改计划指出计划持久化回执、Intake 分流、`agentId` pre-spawn 校验、不可绕过派发、JSON 原子写入、Windows 参数/文件锁恢复等问题。应先跑第 0 轮基线，再按“计划持久化 → Intake 实体初始化 → Agent 身份 → 派发状态机 → JSON 原子写入”的顺序提交和定向测试；Windows 收尾随后实施。
3. **外部副作用的失败模式最难复现。** 把真实 spawn、重复请求、崩溃前后和锁冲突做成可注入故障测试；所有重试须带新的合法参数/幂等键，不能原样重试确定性错误。
4. **隔离与观测仍是生产化短板。** 优先给 `test-agent` 落地受限 runner；并以现有观测平台计划为设计基线，先做 Control Kernel/outbox 的只读状态和错误率视图，避免再创建第二套可写状态源。

## 当前计划同步

`docs/plan/2026-08-05-manager-orchestration-hardening.md` 已同步标注为“待实施的下一轮整改计划”：截至 8 月 6 日，该计划之后没有对应功能提交。P0–P5 提供了它所需的 Control Kernel、task/run/dispatch 和 Schema 基础，但不自动满足其关于计划回执、Intake、pre-spawn 身份、不可绕过派发、原子 JSON 写入及 Windows 恢复的验收条件。

## 证据位置

- `CHANGELOG.md`：本周期每轮“改动 / 原因 / 效果 / 验证”记录。
- `scripts/runtime-guard.mjs`、`config/workflow-state-machine.json`：7/29 起的 Guard 与文件协议边界。
- `scripts/agent-json-harness/`、`scripts/runtime-core/json-ingestion.mjs`、`docs/llm-json-recovery.md`：真实 LLM JSON 验证、恢复与证据链。
- `scripts/control-kernel.mjs`、`scripts/control-core/`、`tests/control-kernel*.test.mjs`、`tests/task-repository.test.mjs`：v2 事务控制、投影、审计、并发和恢复。
- `scripts/migrate-legacy-v1.mjs`、`docs/legacy-v1-migration.md`：遗留取证隔离。
- `docs/report/first-week-report.md`、`docs/report/improvement-roadmap.md`：第一周原始复盘和第二周原始目标。
- `docs/plan/2026-08-05-manager-orchestration-hardening.md`：下周待实施的编排整改计划。
