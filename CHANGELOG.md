# Changelog

## [Unreleased] - 2026-08-07

### 通用静态模型配置与协议清理（2026-08-12）

- 保留 Agent package 当前默认模型，不触发已安装 Agent 的隐式换模。
- 将模型覆盖接口收敛为项目根 `.env`，支持每个 Agent 静态配置不同 `provider/model`；旧 `agent-models.json` 仅保留为兼容回退，禁止运行时自主选模。
- 新增 OpenAI Chat Completions provider 模板：128k context、49,152 输出上限和 `max_completion_tokens` 字段，不含凭据。
- Manager 上下文软阈值调整为 76,800，单个持久 session 累计 token 上限为 200k；两者不被当作单次请求窗口。
- 删除厂商专属路由/provider 样例、Responses 协议内容及对应测试锁定；JSON 清洗、Ajv、失败证据链保持 provider 无关。

### `.env` 更新与 Gateway reload 流程（2026-08-12）

- 明确项目根 `.env` 由安装器和 Node 控制面按需读取，OpenClaw Gateway/Monitor 不会自动监视 `.env` 文件变化。
- 更新 Agent 模型、provider、上下文或输出限制时，流程统一为 `install.ps1` / `install.sh` dry-run → apply → `config validate` / runtime bundle verify → `openclaw gateway restart --safe`；不再要求每次执行 `orchestrator.mjs init`。
- 明确 dry-run 可在 Gateway 运行时执行；apply 前仍须确认没有活动 workflow/task。仅修改 Manager soft budget 等控制面参数无需 Gateway 重启；修改 `MONITOR_*` 后需单独重启 Monitor 服务。
- 修复 PowerShell 安装器在完全幂等同步时将空变更列表误判为缺失参数的问题；`install.ps1 -Apply` 现在允许模型目录和 Agent 配置均已一致的无变更路径正常完成。

### 轻量 StateGraph、持久 Supervisor 与 Agent 会话控制台（2026-08-12）

- StateGraph 使用 `control.db` 内的 SQLite checkpointer，Supervisor 可从 checkpoint 恢复并以固定代码续跑，只在有限决策点唤醒 Manager。
- Agent 执行、dispatch lease、工具宽限和 JSON 契约调用上限统一为 900 秒；Manager wake 与健康检测保持短周期。
- Monitor 新增全部 Agent、session 索引和安全对话 API；控制台左侧显示所有已创建 Agent，右侧支持 session 切换和完整 user/assistant 历史。
- 删除旧的任务/Agent 摘要 activity HTTP 路径，保留健康判定和 SSE 所需 session tailer，以及 Control Kernel、回执、审批、投影恢复等兼容边界。

### Orchestrator Windows 派发恢复与 Manager 旁路收敛（2026-08-11）

#### 变更（Changed）

- Windows 下的 OpenClaw 启动改为显式使用 `ComSpec` 调用 `openclaw.cmd`，通过 `/d /s /c` 和 `windowsVerbatimArguments` 传递参数，不再依赖 Node 的 `shell:true`；统一传递 `--thinking off --verbose off`。新增独立 Agent runner，将 stdout、stderr、启动状态和进程结果持久化到当前 dispatch 的 `.orchestrator` 目录。
- `orchestrator.mjs dispatch` 改为非阻塞启动，立即返回 `STARTED`；新增 `dispatch-reconcile --dispatch-id`，只对账原有 dispatch、摄取结构化产物并写入 completion，避免宿主命令超时后留下无法恢复的 `RUNNING` 状态。
- launcher locator 在 Control Kernel 准备事务前持久化，缩小“已登记 dispatch 但没有恢复定位信息”的崩溃窗口；移除旧的同步 Agent spawn/ingestion 路径，所有正式 dispatch 统一走 detached runner。
- 对历史上没有 launcher 证据的 dispatch，`dispatch-reconcile` 返回 `RECOVERY_REQUIRED`，不凭聊天记录、session transcript 或残留文件伪造 completion，也不擅自标记失败；后续必须重新建立受控、可审计的 run。
- StateGraph 在 task 已 `DISPATCHED/RUNNING` 时返回 `RUNNING`，不再等待长时间 Agent 进程；下一轮只通过原 dispatch 对账，不重复派发。
- Agent 执行超时、dispatch lease、Agent 工具运行宽限期和 Agent JSON 契约测试统一封顶为 900 秒；外部传入 901 秒以上的配置会 fail-closed。Manager 唤醒与健康检测保持更短的独立上限。
- Manager 规则增加人工应急恢复边界：即使用户批准恢复，也只能调用 `dispatch-reconcile`，不得直接执行 `openclaw.cmd`、手工写 SQLite、伪造状态或跳过 test/review/release 阶段。
- Manager 会话策略增加 `summary_only` 用户可见输出约束，禁止逐工具播报、源码探查、session tail 和模型思考过程。

#### 原因（Why）

- 实机对话显示，Windows 下同步 `spawn('openclaw', ..., shell:true)` 被宿主进程终止后，Agent session 可能继续运行，但 Orchestrator 无法完成结果摄取；本次曾在人工批准的应急边界内由 Manager 旁路调用 `openclaw.cmd`，随后手工维护数据库和推进阶段。该批准只解释历史处置，不构成正式运行链路的权限；新链路必须通过 detached runner 和 `dispatch-reconcile` 恢复。

#### 验证（Tests）

- 新增异步 dispatch → launcher result → reconcile → completion 闭环测试。
- 新增 Windows 显式 `.cmd` 启动器测试、StateGraph 非阻塞 `RUNNING` 测试和 Manager summary-only policy 测试。
- 新增 launcher 缺失时保持 `RECOVERY_REQUIRED`、不伪造成功/失败的回归测试；实机验证显式 `ComSpec` spawn `openclaw.cmd --version` 返回 0。
- 完整回归（`npm test`）：128 项通过，0 失败；`git diff --check` 通过；本轮暂未提交 Git commit。

### Manager 紧凑上下文视图（2026-08-11）

#### 变更（Changed）

- `control-kernel snapshot` 新增 `--view manager`，提供面向 Manager 的紧凑 workflow 上下文。
- 紧凑视图只保留当前状态、活动 task、待审批、待处理 dispatch 和最新事件；历史 task、完整 receipt、completion payload、raw log 与历史事件改为按需读取。
- 不改变 SQLite Control Kernel 的权威状态、事件链、审计和完整 snapshot 视图。

#### 验证（Tests）

- 新增 Manager 紧凑 snapshot 回归测试，确认历史与大 payload 不进入默认 Manager 上下文。

### 控制面重复读取保护（2026-08-11）

#### 变更（Changed）

- StateGraph adapter 使用紧凑只读 snapshot；不再把完整历史 task/dispatch payload 放入 Graph state。
- `workflow-run` 新增可选 `--after-revision`：没有新的 Control Kernel revision 时返回 `WAITING_FOR_CHANGE`，不启动本轮 Graph。
- Local Orchestrator 对结构化输出 Schema validator 做进程内复用，并按 Schema 文件修改时间自动失效；不改变 ingestion 语义。

#### 验证（Tests）

- 新增无新 revision 时不启动 Graph 的回归测试。

### 静态 Flash 模型分级与 Manager 会话预算（2026-08-11）

#### 变更（Changed）

- Requirement、Test、Release 和生成的 Dialogue Agent 使用轻量模型；Manager、Architect、Developer、Review 使用高能力模型。该历史分级现已由通用静态 per-Agent 配置替代。
- 模型只在 package/安装配置阶段静态确定，本轮不增加按 task、token 或失败状态动态选模。
- Manager 会话软预算从上下文窗口的 80%/160k 下调到 60%/120k，默认 thinking 从 `high` 下调到 `medium`。
- Manager 默认只读取 `--view manager` 紧凑 snapshot；完整 Control Kernel snapshot、历史 task、receipt、completion payload 和 raw log 改为按 locator 读取。

#### 验证（Tests）

- 新增静态模型分级和 Manager 会话策略测试，防止 Flash/Pro 分工及上下文排除规则漂移。

### Manager 会话轮换入口（2026-08-11）

#### 新增（Added）

- Local Orchestrator 新增 `manager-context` 命令，将 120k 静态软预算判断与紧凑 Control Kernel snapshot 合并为一次确定性读取。
- 达到软预算时返回 `START_NEW_MANAGER_SESSION`；新会话只恢复紧凑 `prompt_context`，不复制旧聊天历史。
- 未提供 token 估算时返回 `MEASURE_CONTEXT`，避免把未知用量误判为预算充足。

#### 验证（Tests）

- 新增预算内继续、达到预算轮换和未知用量三种 Manager 会话回归测试。

### 轻量 LangGraph StateGraph 编排层（2026-08-10）

#### 新增（Added）

- 引入 `@langchain/langgraph`，新增有界 `StateGraph` workflow runner、阶段策略配置和 Graph run result Schema。
- 新增 `orchestrator.mjs workflow-run`：从 Control DB 审计并重建执行上下文，复用现有 task validation、OpenClaw dispatch、结构化结果摄取和 Control Kernel transition command。
- 覆盖 INTAKE、task、Gate、review、failure triage、release 和 FINAL_REPORT 路由；Demo 快速路径仍要求绑定且已解决的真实 `DEMO_FAST` 审批。

#### 权威边界（Changed）

- StateGraph 每次只推进一个稳定 workflow 动作，`WAITING_HUMAN`、`HOLD`、运行中 task 和终态立即返回；重启后从 SQLite 恢复。
- 不启用 LangGraph 独立 checkpointer，不修改 Control Kernel reducer、SQLite workflow 表、事件哈希链或 dispatch outbox。缺少 task、Gate、review findings、release decision 或候选 commit 时 fail-closed。
- 同一 workflow 的 Graph 执行使用本地 workflow lock，workflow mutation 继续使用 `expected_revision` CAS 和受控命令。

#### 验证（Tests）

- 新增 StateGraph 标准入口、人工等待、Demo 审批、缺失 task、task 完成、Gate 重算、候选 commit 和 release 完成回归测试。
- `npm test`：94 项通过，0 失败；依赖审计为 0 个已知漏洞。

### StateGraph 五层动态路由（2026-08-10）

#### 新增（Added）

- 新增统一动态路由器：安全守卫、结构化结果分类、阶段策略、状态机合法边校验和 Control Kernel command 构建。
- Graph run result 增加 `route_kind`、`route_reason` 和路由事实摘要，便于审计本轮为何选择某个目标或停止。
- 增加非法路由、失败分诊、review 返工和 release `NO_GO` 终态的分层单元测试。

#### 边界（Notes）

- 五层是单轮内存决策流水线，不是五份持久状态；最后只生成命令意图，实际状态变更仍由 Control Kernel reducer、CAS 和 SQLite 事务完成。
- 动态路由只能在 `control-state-machine-v2.json` 声明的合法边中选择；无法验证的结果统一停止或进入 `HOLD`。

### StateGraph 合法边单一来源与 Gate 失败回退（2026-08-10）

#### 变更（Changed）

- `workflow-graph-v1.json` 移除所有阶段目标名称，改为只保留 task 类型、Agent、结果分类和路由策略；Control Kernel 以具名合法边（如 `STANDARD_FLOW`、`PASS`、`NEEDS_REWORK`）作为唯一业务路径定义，Graph 只引用边 ID，避免以数组顺序隐式选择目标。
- Control Kernel reducer 从同一份具名边映射取得目标阶段并继续按目标值执行合法性校验；阶段集合、状态条件、终态和既有源/目标合法边均保持不变。
- Gate 结果新增 `failure_target`：当 `overall=FAIL` 时必须提供，路由器会校验其是否为当前 Gate 阶段的 Control Kernel 合法边。`ARCHITECTURE_GATE` 因而可明确回退到 `REQUIREMENTS`、`ARCHITECTURE` 或其他合法目标，而非被 Graph 配置固定为单一路径。
- 更新 Gate 结果 Schema、模板和检查清单；非 FAIL 结果必须将 `failure_target` 设为 `null`。

#### 验证（Tests）

- 新增 Gate FAIL 合法回退与非法目标拒绝测试，以及 StateGraph 阶段、具名边、目标阶段与 Control Kernel 完整同步的测试。
- `node --test tests/workflow-graph-routing.test.mjs tests/workflow-graph.test.mjs`：17 项通过。
- `npm test`：97 项通过，0 失败；`git diff --check` 通过。

### V2 收口：清理旧版残留与文档归档（2026-08-10）

#### 变更（Changed）

- 新版本运行链路统一使用 Control Kernel v2；workflow 的待人工状态统一为 `condition=WAITING_HUMAN`，审批对象继续使用 `status=PENDING`，不再混用旧 v1 状态模型。
- `scripts/runtime-guard.mjs` 收敛为当前 v2 产物校验入口：支持 JSON/JSONL Schema 校验、大小限制、重复 ID 检查、占位符策略和脱敏失败摘要；移除旧文件状态推进、事务恢复和 workflow/task package 检查协议。
- 安装脚本改为创建和同步 `runtime/control/v2`，不再创建或依赖旧的文件型 `runtime/control/workflows` 控制链路。
- 清理旧 v1 状态 Schema、模板、迁移脚本、迁移测试、旧 runtime-core 文件协议及 `tools/legacy-migrations/unsafe-direct-writes/` 下的禁用脚本。
- 更新与 v2 混合的架构、编排、Agent 契约、审批、Gate、证据、上下文传递、Monitor 和安装文档；旧版文档移至 `docs/archive/legacy/`，仅用于人工查阅和审计背景。

#### 保留范围（Notes）

- 未修改 `CHANGELOG.md` 之外的历史记录语义；本次变更不执行历史数据迁移，不删除或改写 `control.db`、历史 workflow/task/event、`legacy-archive` 或 `deletion-backups`。
- 不调整不同角色的模型配置，也不启用按任务动态模型路由，避免扩大本轮变更范围。

#### 验证（Tests）

- `npm test`：80 项通过，0 失败。
- Runtime Guard self-check、`git diff --check` 通过；Control DB SHA-256 保持不变。

### Linux：Tomcat HTTPS 实时 Monitor 部署

#### 改动了什么

- Monitor Dashboard 支持部署在 Tomcat 的 `/monitor/` context：部署脚本仅在 Tomcat staging 中注入同源 `/monitor/api/*`，源码继续支持直接打开本地页面并使用 `127.0.0.1:4319`。
- 新增 Tomcat GET-only Proxy Servlet；它只允许代理到服务器回环地址 `127.0.0.1:4319/api`，不转发浏览器的 Origin、Cookie 或 Authorization，Monitor API 继续保持不对公网监听。
- 新增 `scripts/deploy-monitor-tomcat.sh`、Tomcat Servlet 5 描述符与参数化 Linux `openclaw-monitor.service` 模板，可重复编译、部署页面和代理 Servlet，并将 Monitor 作为开机自启服务运行。
- `package-lock.json` 将间接依赖 `fast-uri` 升级到 3.1.5，消除此前审计报告中的高危漏洞。

#### 部署与回滚

- 部署顺序：安装/重启 `openclaw-monitor.service`，然后运行 `bash scripts/deploy-monitor-tomcat.sh`；验证 HTTPS 页面、`/monitor/api/health` 与 SSE 后再对外使用。
- 回滚：停止 `openclaw-monitor.service`，将 `/var/lib/tomcat10/webapps/monitor/` 替换为此前备份内容或删除该独立 context；不会影响 Tomcat 的 `ROOT` 应用。代码回滚使用本分支提交的父提交。

#### 验证

- `node --test tests/monitor-static-dashboard.test.mjs tests/monitor-tomcat-proxy.test.mjs`：3 项通过。
- Java 17 使用 Tomcat Servlet API 编译 Proxy Servlet 通过；替换运行用户、项目路径和 Node 路径后的 systemd 单元验证通过。
- 实际部署后，HTTPS 页面、同源 `/monitor/api/health` 与 SSE snapshot 均通过；4319 保持仅监听 `127.0.0.1`。

### P0/P1：本地编排边界、只读看板与安全重装

#### 改动了什么

- 新增本地 `orchestrator`：workflow、task、dispatch、Agent ID、session、receipt、completion 和 retry 均从 Control DB 的已验证 task 派生；Agent 不再决定派发或状态写入。
- 统一 Agent JSON/JSONL 结果路径为 `.agent-raw → 本地清洗 → Ajv 校验 → 原子发布 → ingestion receipt`；Control Kernel mutation 固定为本地 capability 身份。
- Monitor 删除公共写入、监督和 Agent 交互入口，公共 API/UI 只保留任务阶段、状态、负责 Agent、健康状态及用户可见 assistant 对话；thinking、工具细节、session/path/receipt 等控制信息不再输出。
- 重写 `scripts/reinstall-agents.ps1`：仅选择 package manifest 与现有 OpenClaw workspace/agentDir 精确匹配的已安装项目 Agent；执行时必须显式确认 Gateway 已停止。流程固定为备份、删除已验证 Agent、确认配置已移除、清理已验证旧 runtime、重装、bundle/config 校验，并在备份目录写入结果记录；失败时恢复配置和 runtime 备份。
- 修复连续删除 Agent 后 OpenClaw 偶发返回“成功但无完整 JSON”的 `agents list --json`：安装器保持统一严格 JSON 校验，并以有界重读及严格校验的 `config get agents.list` 作为后备事实源，不再把短暂 CLI 输出当作有效数据。
- README 更新为本地 Orchestrator 信息流、只读看板边界和新的 Agent 重装命令；未完成部署风险与实时看板为空的事实记录在 `docs/problem/2026-08-07-agent-boundary-runtime-and-information-flow.md`。
- 本地结构化输出入库器现在会在解析、暂存文件安全检查、缺失输出或 Ajv Schema 校验失败时，自动写入 artifact 的 `.orchestrator-ingest/*.failure.json` 与追加式 `validation-errors.jsonl`；无效原文继续保留在 `.agent-raw`，日志仅保存 hash 和脱敏摘要。
- README 收缩为当前功能、启动方式、Agent 角色、JSON 错误证据和 Agent 更新步骤，移除已过期的原生 manager 调度、可交互 Monitor 和 token 配置说明。

#### 验证

- `pwsh -NoProfile -File scripts/reinstall-agents.ps1 -RuntimeRoot runtime` dry-run：仅识别 7 个路径匹配的项目 Agent；未处理 `main` 或 `dialogue-agent`，未写入配置或 runtime。
- Gateway 停止期间已实际重装并验证 7 个项目 Agent；`main` 未变。manager allowlist 为 6 个 worker，所有 worker allowlist 均为空。
- `openclaw config validate --json`、`node scripts/runtime-bundle.mjs verify --project-root . --runtime-root runtime` 通过（105 entries）。
- 自动测试分组共 171 通过、0 失败；Runtime Guard 有 2 个符号链接用例因当前 Windows 账户权限跳过。
- 新增 Orchestrator 无效暂存 JSON 用例通过：验证原始文件、失败收据、错误 JSONL、脱敏摘要和任务失败状态均由本地代码生成。

### Agent reinstall：兼容 OpenClaw 诊断输出、锁冲突与运行时同步

#### 改动了什么

- PowerShell 安装、重装和组件管理脚本现在能从 OpenClaw 混入诊断行的输出中提取合法 JSON。
- 对配置版本冲突、文件锁超时和 stale revision 增加有限退避重试，避免删除/添加 Agent 的瞬时并发失败。
- 验证器增加“诊断文本 + JSON”回归场景。
- 已完成本机 7 个项目 Agent 的实际重装；运行时 Manager/Developer 规则与源码哈希一致，runtime bundle 校验通过。

#### 验证

- `pwsh -NoProfile -File scripts/validate-install.ps1 -SkipOpenClaw`：124 项通过。
- `node scripts/runtime-bundle.mjs verify ...`：通过，105 entries 无 drift。
- `openclaw agents list --json`：main + 7 个项目 Agent 均存在。
- OpenClaw Gateway 已重新启动，`openclaw gateway status`：running / connectivity probe ok。

### Monitor Phase 9：固定本地配置与零输入连接

#### 改动了什么

- Supervisor Core 自动读取项目根目录的 `.env`，本地默认 token 固定为 `openclaw-local-monitor`。
- 新增 `/api/client-config`，静态 Dashboard 启动时自动取得本地 token 并连接，不再要求手工复制。
- 看板每次启动优先探测当前默认地址，并自动替换浏览器中残留的旧端口或旧 token。
- activity/checkpoint 上报脚本自动复用 Monitor 配置，不再要求当前终端预先设置 `MONITOR_TOKEN`。
- 默认端口由 `4310` 调整为 `4319`；本机 `4310` 已被 `QQ.exe` 占用，是此前 `Failed to fetch` 的直接原因。
- 增加受版本控制的 `.env.example`；实际 `.env` 继续被 Git 忽略。

#### 验证

- `npm run test:monitor`：23 项通过。
- 实际启动 Supervisor 后，`http://127.0.0.1:4319/api/health` 返回 `HEALTHY`，识别到 4 个 workflow。
- `/api/client-config` 正确返回固定本地 token，看板可自动完成配置。

### Monitor Phase 8：可靠性、安全、启动脚本与完整回归

#### 改动了什么

- 为 `monitor.db` 增加遥测保留策略：按事件数量和活动天数清理，数据库可删除并可由控制事实重建。
- 增加 Windows PowerShell 与 POSIX 启动脚本，统一设置项目根目录、runtime 根目录和监听端口。
- 增加 100 个活动 workflow 快照性能基线与遥测保留边界测试，并在 Supervisor 启动、维护周期和关闭时处理清理任务。
- 更新架构、状态恢复、README 与计划文档，明确静态 HTML 看板、宿主机原生 Supervisor、默认 shadow watchdog 和关闭的 manager wake。

#### 验证

- `npm test`：完整回归通过；Runtime Guard 105 项通过、2 项因当前 Windows 会话无符号链接权限跳过，其余套件全部通过。
- `npm run test:monitor`：23 项通过。
- `git diff --check`：通过。
- 当前环境没有可用浏览器实例，未执行截图式视觉验收；静态结构测试和 API 测试已通过。

### Monitor Phase 7：人工控制请求与受控 retry

#### 改动了什么

- 新增 `task-retry` Control Kernel 边界：仅允许已确认 FAILED/LOST 的终态 dispatch 创建新 attempt/run，并禁止复用 artifact/context 路径。
- Dashboard 增加 SEND_MESSAGE、RECONCILE、RETRY_REVIEW、PAUSE、RESUME、CANCEL 和 ESCALATE 请求及影响确认。
- 更新 manager 规则，将人工请求映射到 audit、原 session 核查、状态机和审批；网页请求本身不改变控制状态。

#### 为什么要改

- 真正失败后的恢复需要保留历史 run 和外部副作用事实；不能覆盖旧 artifact，也不能由 Watchdog 或网页直接重跑。

#### 验证

- `npm run test:control-kernel`：21 项通过，包含失败 completion、新 run 和 retry budget/路径边界。
- `npm run test:monitor`：新增所有人工 request type 不改变 workflow 状态的测试。
- `npm run test:runtime-bundle`：3 项通过。
- `node --check monitor/ui/app.js` 和 `git diff --check` 通过。

### Monitor Phase 6：监督请求自动化与 Manager Wake Adapter

#### 改动了什么

- Watchdog 非 shadow 模式现在通过 supervision repository 创建完整、幂等的 NUDGE request 和 wake outbox。
- 新增默认关闭的 Manager Wake Adapter：Control Kernel audit 前置、指定 manager session 校验、CLI 参数数组调用、失败退避和 durable wake receipt。
- 更新 manager-agent 规则和工具协议：启动/恢复/被唤醒时查询、claim、核查原 session，并用 receipt 结束监督请求；原 session 未确认终结前禁止 retry/spawn。

#### 为什么要改

- 监督外部副作用必须经过 request/outbox/receipt 闭环，并且只能唤醒唯一编排者，不能让 Watchdog 直接控制工作 Agent。

#### 验证

- `npm run test:monitor`：20 项通过。
- `npm run test:runtime-bundle`：3 项通过。
- `node --check monitor/wake-adapter.mjs` 和 `git diff --check` 通过。
- 真实 OpenClaw CLI 已确认支持 manager `--session-key` 定位和 JSON session 列表；自动唤醒保持默认关闭，测试使用注入 runner，未向真实 manager 发送消息。

### Monitor Phase 5：健康分类与 Watchdog 影子模式

#### 改动了什么

- 新增多证据 Health Classifier、持久化 task health snapshot 和 `/api/tasks/:id/health`。
- 新增 Watchdog shadow mode：只记录拟创建的 NUDGE，同一 task/run/冷却窗口幂等去重。
- 增加 STARTING、RUNNING、WAITING、BLOCKED、STALE、POSSIBLY_STALLED、终态和 UNKNOWN 判定；lease 过期不直接判 LOST，长工具调用使用独立宽限窗口。
- Dashboard task、Agent 和总览接入派生健康状态。
- Monitor 测试改为单并发，避免 Windows 并行 SQLite 测试触发虚拟内存分配失败。

#### 为什么要改

- 主动监督必须先证明停滞判定的证据质量和误报率，不能按单一更新时间直接催办或 retry。

#### 验证

- `npm run test:monitor`：17 项通过。
- `node --check monitor/health-classifier.mjs monitor/watchdog.mjs monitor/ui/app.js` 通过。
- `git diff --check` 通过。

### Monitor Phase 4：可直接打开的静态 HTML Dashboard

#### 改动了什么

- 新增无需构建的 `monitor/ui/index.html`、`app.js`、`styles.css` 和本地配置文件。
- 实现 workflow 索引、系统总览、13 阶段轨道、task/session 卡片、Agent relay、SSE live feed、task activity 详情和人工 NUDGE。
- 增加 loopback CSP、sessionStorage token、断线重连、sequence 恢复、响应式布局和 reduced-motion 支持。

#### 为什么要改

- 用户需要无需启动前端工程即可观察多 Agent 运行；静态页面仅作为观察入口，关闭页面不影响监督核心。

#### 验证

- `node --check monitor/ui/app.js` 通过。
- `npm run test:monitor`：15 项通过，包含无外部依赖和无需构建检查。
- 本地浏览器控制当前无可用实例，因此未生成视觉截图；结构、响应式和 API 行为已由自动化检查覆盖。
- `git diff --check` 通过。

### Monitor Phase 3：Activity、遥测库、脱敏与兜底采集

#### 改动了什么

- 新增 Agent Activity、Checkpoint 和 Monitor Event 契约，以及独立可重建的 `monitor.db` repository。
- 新增 activity API/CLI、Agent 和 task 活动查询、递归 thinking/凭据/路径脱敏与文本截断。
- 新增 OpenClaw session JSONL 增量 tailer、半行 cursor 恢复、tool/assistant 安全摘要解析和结构化产物 watcher。
- 更新通用 Agent 规则：有 Monitor 环境时在关键节点上报，token 只从环境读取且不得落盘。

#### 为什么要改

- 仅靠 task `updated_at` 无法判断 Agent 是否真实推进；显式 activity 提供高可信信号，session 和 artifact 变化用于 Agent 未及时上报时的安全兜底。

#### 验证

- `npm run test:monitor`：14 项通过。
- `npm run test:agent-json:offline`：12 项通过。
- `node --check monitor/config.mjs` 和 `git diff --check` 通过。

### Monitor Phase 2：原生 Supervisor Core、HTTP API 与 SSE

#### 改动了什么

- 新增原生 Node.js Supervisor Core、配置加载、事件保留/回放 hub、loopback HTTP API 和 SSE stream。
- 提供 health、workflow、snapshot、workflow event、task、supervision 查询与受 token 保护的监督请求 API。
- 新增 `supervisor:start`、`supervisor:check`、配置样例和运行文档。
- 增加 HTTP、Origin/token、防越权和 SSE 初始快照/重放测试。

#### 为什么要改

- 在不引入第二个编排器或前端服务依赖的前提下，为静态 HTML 看板提供一致、可恢复、最小暴露的本地数据接口。

#### 验证

- `npm run test:monitor`：9 项通过。
- `git diff --check` 通过。

### Monitor Phase 1：Control Kernel 监督事实与只读快照

#### 改动了什么

- 新增 supervision request/claim/receipt 和 manager wake record Schema，以及 SQLite `supervision_requests`、不可变 `supervision_events`、`manager_wake_outbox` 和幂等 operation 表。
- 新增 `snapshot`、`supervision-request/list/claim/complete/events`、`wake-outbox` 和 `wake-record` Control Kernel 命令。
- 扩展 Control Kernel audit，验证监督作用域、事件哈希链、请求状态与 wake outbox。
- 新增 Monitor 测试入口及监督事务、幂等、wake、快照和篡改检测测试。

#### 为什么要改

- 自动或人工催办必须先形成可审计控制事实和 outbox，不能由 Watchdog、网页或外部调用直接控制工作 Agent。

#### 验证

- `node --test tests/monitor-supervision.test.mjs tests/control-kernel.test.mjs tests/task-repository.test.mjs`：19 项通过。
- `git diff --check` 通过。

### Monitor Phase 0：基线与原生监督 ADR

#### 改动了什么

- 新增 `docs/adr/2026-08-06-native-supervisor-core.md`，冻结宿主机 Supervisor Core、静态 HTML Dashboard、唯一编排者和故障隔离边界。
- 新增 `docs/monitor-baseline.md`，记录 Node/OpenClaw 版本、基线测试、CLI 能力、session JSONL 结构和自动监督进入门槛。

#### 为什么要改

- 在扩展数据库和实现常驻服务前先固定权威状态、外部副作用和隐私边界，避免 Monitor 演变成第二个控制面。

#### 验证

- `npm test` 基线全量通过。
- 已只读探测 `openclaw agent --help`、`openclaw sessions --help` 和 session JSONL 字段结构，未输出 session 内容。
- `git diff --check` 通过。

### README 同步可观测性计划状态

#### 改动了什么

- 在 `README.md` 中增加可观测性与监督计划状态，明确 Supervisor Core、静态 HTML 看板、影子模式和自动监督的实施边界。
- 在文档索引中加入可观测性计划与 Manager 编排加固计划，便于从项目入口定位阶段门槛和完整方案。

#### 为什么要改

- 计划修订完成后，需要在项目入口明确区分“已经实现的 Control Kernel 能力”和“仍待实施的看板/自动监督能力”，避免把计划误认为已交付功能。

#### 验证

- README 链接目标存在。
- `git diff --check` 通过。

### 可观测性计划改为原生监督核心与静态 HTML 看板

#### 改动了什么

- 将 `docs/plan/2026-08-04-agent-observability-monitor.md` 更新为 2.1：监督、健康判定、Watchdog 和 manager 唤醒固定由宿主机原生 Node.js Supervisor Core 承担。
- Dashboard 改为可直接打开的原生 `index.html`、`app.js` 和 `styles.css`，移除容器部署和前端构建链规划。
- 补充当前 Control Kernel P0～P5 已完成、Manager 编排加固仍待实施的基线修正，并为自动 NUDGE、manager 唤醒和受控 retry 增加明确进入条件。
- 增加节点职责、交互对象、交换信息，以及页面未打开、关闭和浏览器重启时监督不中断的验收场景。

#### 为什么要改

- 图形化看板只是观察入口，不应成为监督运行的依赖；用户不打开 HTML 页面时，停滞检测和监督闭环仍需持续工作。
- 当前 Manager 的真实 spawn 身份校验、统一派发入口和中断恢复尚未按加固计划实现，自动监督不能提前假设这些边界已经可靠。

#### 验证

- 计划文档中已无容器部署相关文件、命令、阶段或验收项。
- `git diff --check` 通过。

### 记录 Manager-Agent 编排与执行协议整改计划

#### 改动了什么

- 新增 `docs/plan/2026-08-05-manager-orchestration-hardening.md`，记录计划持久化回执、Intake 分流、workflow/task/run 初始化、Agent 身份校验、不可绕过派发、JSON 原子写入、Windows 执行与恢复的完整整改计划。

#### 为什么要改

- 将最新一轮审计发现的问题、分阶段实施边界、测试要求、提交策略和最终验收标准固化到仓库，避免计划只存在于对话上下文中。

### OpenClaw Agent 单次输出预算上调

#### 改动了什么

- 将当时自定义模型的显式 `maxTokens` 统一设为 `49152`。当前通用 OpenAI Chat Completions 模板继续保持该输出上限。
- 该配置覆盖 OpenClaw 模型目录中 Pro 的 8192 和 Flash 的 16384 隐式输出上限，应用于当前注册的 `manager-agent`、`requirement-agent`、`architect-agent`、`developer-agent`、`review-agent`、`test-agent`、`release-agent`。

#### 为什么要改

- 长 HTML 生成任务在 8192 tokens 时以 `stopReason: length` 截断，导致未完成的工具调用无法交付。

#### 验证

- `openclaw config validate --json` 通过；四个模型配置均报告 `maxTokens: 49152`、`compat.maxTokensField: "max_tokens"`，上下文窗口保持 `1000000`。
- 独立 Gateway 探测会话实际记录 `outputTokens: 49152`，确认请求不再被旧的 8192 输出上限截断。

### 重装已安装 Agent、配置与 runtime 同步

#### 改动了什么

- 新增 `scripts/reinstall-agents.ps1`：动态读取 package manifest，只重装当前配置路径与本项目 runtime 完全匹配的 Agent；OpenClaw 配置乐观锁冲突会刷新配置后有界重试。
- 重装前备份 OpenClaw 配置及受管理的 Agent workspace/state，并在 package 未指定模型时保存并恢复每 Agent 的既有模型路由；删除后复用 `install.ps1 -Apply` 更新 `agents.list`、runtime workspace、install manifest 和 runtime bundle。
- 增加重新安装命令与安全边界文档。

#### 验证

- 2026-08-05 已在当前 OpenClaw 环境预演并执行完整卸载和重建：仅处理 7 个内置项目 Agent，未安装或更改 `dialogue-agent`。本轮改造后改用通用 `config/agent-models.example.json` 进行显式静态覆盖。
- `openclaw config validate --json` 通过；`openclaw agents list --json` 为平台 `main` 加上述 7 个项目 Agent。
- `runtime-bundle.mjs verify` 通过（105 entries，SHA-256 `da0fa5ddba12449a9077ffed06f4b3514062f18d209c4d3f310131e1826f3a3d`）；Control Kernel audit 为 `CONSISTENT`。
- `npm run test:runtime-bundle`（3 项）和 `node --test tests/validate-install.test.mjs`（2 项）通过。

本项目遵循语义化的变更记录风格。日期格式 `YYYY-MM-DD`。

## [Unreleased] - 2026-08-05

### P0：运行协议止血与安装漂移防护

#### 改动了什么

- 新建 `dev` 开发分支承载 P0-P5 控制面重构。
- 清除 manager 规则中“先 `append-event`、再分别覆盖 workflow/active/task”与“必须 `commit-transition`”并存的冲突；新建、推进和恢复 workflow 均只允许事务提交。
- 新增 `scripts/runtime-bundle.mjs`，对 package workspace、共享规则、模板和托管 skill 生成确定性摘要，并在安装后记录、在 manager 恢复前验证源码与运行时副本是否一致。
- 将 8 个会直接覆盖 runtime 控制文件的早期一次性 CJS 脚本迁移到 `tools/legacy-migrations/unsafe-direct-writes/` 并改为 `.disabled`，仅保留取证参考。
- 将本轮开始前已有的 result JSON 契约强化、任务输出契约声明、DevelopmentGate `DEV-0` 阻断项及对应测试一并纳入 P0 基线。

#### 为什么要改

- 2026-08-04 的 Demo 实际加载了 2026-07-27 安装的旧 manager workspace，未使用仓库中已经实现的事务和 dispatch ledger；源码规则本身又同时包含两套互斥写法。
- 仅依靠 Guard 事后检查不能阻止旧 prompt 或临时脚本先写出分裂状态。
- 新任务若没有固定声明并校验默认结构化输出，仍可能在缺失或错误的 `result.json` 下被错误推进。

#### 改后的效果

- manager 在安装 bundle 漂移时会失败关闭，不能继续用旧 prompt 恢复或推进 workflow。
- 新流程不再把 `append-event` 当作正常状态推进入口；直接写 runtime 的历史脚本默认不可执行。
- result JSON 和 DevelopmentGate 的契约错误保持阻断，不能再降级为非阻塞元数据。

#### 验证

- `npm test` 通过：Runtime Guard 105 通过、2 项因当前 Windows 会话无符号链接权限跳过；离线 Agent JSON 12 通过；runtime bundle 2 通过；Bash/PowerShell 安装回归 2 通过。
- `git diff --check` 通过。

### P1：SQLite Control Kernel 与命令式状态迁移

#### 改动了什么

- 新增 Control Kernel v2、SQLite repository 和纯 reducer；workflow 当前状态、幂等命令与不可变哈希事件在同一事务内提交。
- 新增正交的 `phase + condition + outcome` 状态模型及 `resume_phase/resume_condition`，避免 HOLD/WAITING 恢复目标依赖聊天记忆。
- 新增 `transition-command` 与 `control-state-v2` Schema，以及版本化的 `control-state-machine-v2.json`。
- 新增 `BOOTSTRAP`、阶段推进、等待、HOLD、恢复、候选提交、完成、失败、取消和隔离命令；manager 不再负责计算 revision 或下一版状态。
- workflow 创建时固定 `contract_set_id`、状态机版本与安装 bundle SHA-256。

#### 为什么要改

- 多个 JSON 文件同时充当当前状态源，即使具备补偿事务，也会留下部分写入、恢复顺序和跨 workflow 全局索引竞争问题。
- 把阶段状态与 WAITING/HOLD 混在同一枚举中，恢复时无法确定原阶段和原等待条件。

#### 改后的效果

- 每个成功命令恰好生成一个 revision 和一个事件；失败命令不留下中间状态。
- 同一 command 重试为幂等重放，复用 command ID 提交不同内容会被拒绝。
- 事件表由 SQLite trigger 禁止 UPDATE/DELETE，当前状态可由事件链审计。

#### 验证

- Control Kernel 6 个新增测试通过，覆盖原子推进、非法边与 revision 冲突、暂停恢复、幂等重放、事件不可变、持久化重启和终态约束。
- `npm test` 全量通过：Runtime Guard 105 通过、2 跳过；Agent JSON 12、runtime bundle 2、Control Kernel 6、安装回归 2 全部通过。
- Runtime Guard `self-check` 成功编译 28 份 contract；两份 Kernel 内部 contract 明确不进入 LLM 通信场景。
- `git diff --check` 通过。

### P2：派生投影、active view 与确定性恢复

#### 改动了什么

- 新增 SQLite `active_workflows` view，以 `condition != TERMINAL` 自动派生活动工作流。
- 每个成功 transition 同事务写入 projection outbox；投影器在全局锁内生成 v2 workflow、events JSONL 和 active index 只读文件。
- 新增数据库审计：SQLite integrity、事件 seq/revision、前序哈希、事件哈希、from/to state、command/event 对应、当前快照和 active view 全部重算。
- 新增投影漂移审计和 `recover`：只有权威数据库通过审计时才允许重建投影；权威状态损坏时失败关闭为 HOLD。
- 新增 `active`、`project`、`audit`、`recover` Control Kernel CLI 命令及 v2 event/active projection Schema。

#### 为什么要改

- 全局 `active-workflows.json` 由各 workflow 事务分别覆盖时存在跨 workflow 丢更新风险，也会成为第三份状态事实源。
- 多文件事务崩溃恢复复杂；JSON/JSONL 更适合作为可重建审计视图，而不是当前状态的写入入口。

#### 改后的效果

- active 状态不再人工同步；终态提交后自动从 view 和下一次投影中消失。
- 投影可以删除后重建，任何投影修改都不会反向污染权威状态。
- 恢复先证明数据库和事件链一致，再处理投影，不会根据聊天或滞后 JSON 猜测。

#### 验证

- Control Kernel 9 项测试通过，覆盖投影/active 派生、投影漂移恢复及权威状态/事件不一致检测。
- 完整回归通过：Runtime Guard 105 项通过、2 项 Windows 符号链接场景跳过；Agent JSON 12 项、runtime bundle 2 项、安装测试 2 项全部通过。
- Runtime Guard `self-check` 成功编译 30 份 contract。
- `git diff --check` 通过。

### P3：Task、dispatch outbox 与结果验收闭环

#### 改动了什么

- 新增 SQLite task、task run、不可变 task event、dispatch、dispatch outbox 和幂等 operation 表。
- 新增 `task-register` / `task-validate` / `task-get`、`dispatch-prepare` / `dispatch-receipt` / `dispatch-list` / `dispatch-outbox`、`result-ingest` 命令。
- task 注册时固定 workflow contract set 和 output contract version；派发前验证 context identity、输入哈希、依赖、Agent 策略、绝对路径和全部结构化输出声明。
- dispatch intent、task `DISPATCHED` 状态和 outbox 在一个事务内提交；session receipt 严格按 `SENT → ACKNOWLEDGED → RUNNING` 对账。
- completion ingestion 校验 result 哈希、session 身份和 task 固定的所有必需 JSON/JSONL；验证失败不改变 task/dispatch 状态。
- manager v2 规则改为以 Control Kernel 为唯一状态写入边界，保留原有 Agent 分工和 OpenClaw `sessions_spawn` 调度职责。

#### 为什么要改

- 外部 session 创建无法与本地数据库形成真实原子事务；若先 spawn 后写状态，崩溃会产生“已运行但无记录”，反序则可能留下“有 intent 但未 spawn”。
- task 完成状态若先于输出契约校验写入，会重现旧 workflow 中“控制层 COMPLETED、实际 result 缺失”的问题。

#### 改后的效果

- PENDING intent 是可恢复、可查询的外部副作用边界；它不会被误判为已派发或自动 LOST。
- task 只有在权威 run、session 与结构化产物全部闭合后才能完成；失败输入保持原状态并可安全修正后重试 ingestion。
- Agent 的业务职责没有变化，Manager 仍负责调度和 Gate，但不再分别维护 task/dispatch/result 状态文件。

#### 验证

- Control Kernel 12 项测试通过，其中 3 项覆盖 task/dispatch/result 闭环、缺失必需输出失败关闭和 dispatch 幂等。
- 完整回归通过：Runtime Guard 105 项通过、2 项 Windows 符号链接场景跳过；Agent JSON 12 项、runtime bundle 2 项、安装测试 2 项全部通过。
- Runtime Guard `self-check` 成功编译 30 份 contract 和 11 份 template。
- `git diff --check` 通过。

### P4：遗留 v1 取证归档与隔离迁移

#### 改动了什么

- 新增 `migrate-legacy-v1.mjs plan/apply` 和版本化 forensic quarantine report Schema。
- 迁移器递归清点并哈希旧 control/artifact tree，复制后重算摘要，保存旧 active index，并将 archive 证据设为只读。
- v2 仅创建新的 `legacy-quarantine-tombstone-v1` tombstone；旧 snapshot/event 不导入为 v2 历史，旧 candidate 只记录为不受信观察值。
- 新增不可变 `legacy_quarantines` 报告表；相同 migration 可重放，源、archive 或报告冲突时失败关闭。
- 已对本机 4 个旧 workflow 执行 `MIG-legacy-quarantine-20260805`，原始目录未修改；归档位于 `runtime/control/legacy-archive/v1/MIG-legacy-quarantine-20260805`。

#### 为什么要改

- `WF-a899188b...` 的现存事件只到 revision 13，snapshot 声称 revision 18，active index 仍停在 revision 7；任何自动补链都会把推测伪装成历史事实。
- 其他遗留 workflow 分别存在旧 Schema、非终态未登记和已隔离记录，不能与新 v2 状态混用。

#### 改后的效果

- 遗留证据、当前观察值和可信事件前缀被分别保存；可审计但不可恢复执行。
- 4 个 v2 tombstone 均为 revision 2、`QUARANTINED`、candidate `null`，不会进入 active view。
- 实际迁移后数据库审计为 `CONSISTENT`：4 workflows、8 events、8 commands、8 applied projection outbox records，active workflows 为 0。

#### 验证

- 2 项迁移测试通过：dry-run 零写入与可信前缀识别；精确归档、源树不变、幂等隔离导入。
- 完整回归通过：Runtime Guard 105 项通过、2 项 Windows 符号链接场景跳过；Agent JSON 12 项、runtime bundle 2 项、Control Kernel 12 项、安装测试 2 项全部通过。
- Runtime Guard `self-check` 成功编译 31 份 contract 和 11 份 template。
- `git diff --check` 通过。

### P5：并发、崩溃恢复、E2E 与最终文档

#### 改动了什么

- 新增同 workflow 并发 CAS、不同 workflow 并发 active、projection 高水位并发测试。
- 为 workflow repository 和投影器加入可注入测试 failpoint，覆盖提交前回滚、提交后响应丢失和投影 outbox 恢复。
- 新增 spawn 前重启、completion exactly-once、完整 v2 阶段路径、数据库重启和投影删除重建测试。
- 审计扩展到 task snapshot/列、run、task event 哈希链、dispatch intent/receipt/completion 和 dispatch outbox。
- 最终更新 README、总体架构、Control Kernel、状态恢复、Manager 编排与完成度文档；明确 v2 默认、遗留 v1 边界及暂不引入 LangGraph 的理由。

#### 为什么要改

- 单线程功能测试不能证明并发写入、响应丢失或外部 spawn 间隙不会重新产生状态不一致。
- 只审计 workflow 而不审计 task/dispatch，会留下“workflow 一致但任务完成事实已漂移”的盲区。

#### 改后的效果

- CAS、outbox 高水位、幂等重放和确定性恢复均有可复现自动化证据。
- 完整 v2 workflow 在重启并删除全部投影后仍可只凭数据库恢复到相同终态。
- 用户入口文档不再把遗留可写 JSON 协议描述为新 workflow 的默认路径。

#### 验证

- Control Kernel 20 项测试通过：6 项 P5 resilience/E2E、10 项 workflow/projection、4 项 task/dispatch/result/audit。
- 完整回归通过：Runtime Guard 105 项通过、2 项 Windows 符号链接场景跳过；Agent JSON 12 项、runtime bundle 2 项、legacy migration 2 项、安装测试 2 项全部通过。
- 本机迁移数据库最终审计为 `CONSISTENT`：4 workflows、8 events、8 commands、8 applied projection records、0 active workflows。
- Runtime Guard `self-check` 成功编译 31 份 contract 和 11 份 template。
- `git diff --check` 通过。
- 既有本机 runtime 尚无 `runtime-bundle.json`（安装早于 P0）；为避免未经请求改写用户 OpenClaw 配置，本轮未执行 apply 安装。新建真实 workflow 前必须先重新安装同步并记录 bundle。

## [0.3.0-dev.0] - 2026-08-04

### 改动了什么

- 新增 `check-task-package` Guard 命令，在写入 `TASK_DISPATCHED` 事件和创建 Agent 会话前校验完整 input package、manifest 哈希、规范 artifact 路径与规范 worktree 路径。
- 新增 `QUARANTINED` 工作流终态。该终态要求 append-only 隔离事件、`quarantine-report.md`、`final-report.md` 和活动索引移除；Guard 只在审计边界通过后允许其结束，不会改写历史 task/run 证据。
- `task.json` 新增 `structured_outputs[]`。Manager 必须声明跨 Agent JSON/JSONL 的产出路径、Schema、格式、是否必需和产出 Agent；完成任务由 Guard 再次以 Ajv 校验声明产物。
- 新增 `config/manager-session-policy.json`，保持 `thinking=high` 和 200k 模型窗口，同时将 Manager 会话软预算设为 80%（160k token），达到预算后从文件化状态创建新会话恢复。
- 已将运行中的 `WF-ef1c5f87-93c5-4ec7-a074-3dea54831ca1` 正式隔离为 `QUARANTINED`，保留原始控制面、artifact 与 Guard 错误证据，不再参与恢复。
- 清除了 `manager-agent` 父会话及当时两个 TUI 会话遗留的 `providerOverride`、`modelOverride` 与 `modelOverrideSource`。这些会话级字段曾将 Manager 的实际调用模型固定为旧 provider。
- 保持 OpenClaw Agent 配置的 Manager 默认模型为 `newapi-responses/gpt-5.6-luna`，未改动其余 6 个项目 Agent、平台 `main` Agent、模型凭据或历史工作流会话。
- 规定后续项目改动须在用户完成检查/验收后，同步更新本文件、`README.md` 与 `docs/current-progress-assessment.md`，记录变更、验证结果、完成状态与遗留风险。
- 7 个 Agent 的项目配置统一使用 Chat Completions API；当前仅保留通用 OpenAI Chat Completions provider 模板。
- JSON/JSONL LLM 回复链路新增保守清洗：去 BOM、去唯一 Markdown fence、或从唯一解释性前后缀中提取完整 JSON/JSONL；多个候选一律拒绝猜测，并记录原始/清洗 SHA-256 与转换元数据。
- 新增 enum、type、schema drift、输出截断和空 content 的固定重写模板；所有类别共用首次调用之外最多两次的同会话重试预算。核心 `result`、`task` 与 JSON 校验错误契约为身份、状态、枚举、结构化产物和错误字段增加了描述。
- 新增 `docs/llm-json-recovery.md`，记录厂商无关的清洗边界和两段可复核模板。

### 为什么要改

- 历史 workflow 在 manifest、输入哈希、任务事件和 worktree 路径上发生不一致，导致 Guard 正确 fail-closed；此前缺少派发前预检与可审计的隔离出口。
- 同一 Manager 会话持续携带完整工具日志和失败记录，造成 token 消耗与流中断风险；当前实际使用未触及 200k 上限，因此扩大窗口不能解决问题。
- 既有 Ajv 校验未把所有任务声明的结构化产物纳入控制面复检。
- `openclaw models status --agent manager-agent --check` 显示 Agent 默认模型正确，但 TUI 新会话会继承父会话保存的旧模型覆盖，导致界面和实际调用不一致。
- 仅修正运行时配置不足以防止会话层覆盖重新造成误判；项目状态、用户可见操作说明和变更历史也需要在验收后保持一致。

### 改后的效果

- 新任务在派发前即可因缺失 input、哈希不符或路径异常被拒绝，不会先写入不一致的 `DISPATCHED` 状态。
- 无法在不篡改不可变历史的前提下修复的 workflow 可以被隔离并从恢复索引移除；新任务必须从新的 workflow 重建。
- 已声明 JSON/JSONL 产物在完成时必须通过其受信任 contract；聊天文本和 Markdown 摘要不能单独推动状态。
- Manager 在 160k token 时换新会话并由 `recovery-check` 从文件恢复，避免用扩大窗口掩盖上下文累积。
- 重新启动 Manager TUI 后，新会话不再继承旧模型覆盖。
- 已存在的历史会话和工作流产物保留原始记录；本次只移除了会改变后续调用路由的覆盖字段。
- 后续状态不会在未完成用户检查时提前标记为已验证；验收后将由三份项目文档共同反映实际状态。
- 配置样例与路由文档已统一到通用 Chat Completions 配置。
- 格式错误不再依赖模型自我修复：已知包装问题可确定性清除，enum/type 不合法、schema drift 和截断会获得精确诊断并 fail-closed；两次重写后仍失败保留全链路证据。

### 验证

- `npm test` 通过：82 项 Runtime Guard 测试通过，2 项因当前 Windows 会话无符号链接权限跳过；离线 LLM harness 8 项和安装验证 2 项通过。
- `check-workflow` 已对被隔离 workflow 返回 `effective_status=QUARANTINED`、`state_revision=9`、`event_count=9`。
- Manager 父会话及相关 TUI 会话均已确认不存在 provider/model override。
- `openclaw config validate` 已验证当时 OpenClaw 配置；当前改造不修改 7 个 Agent package 的默认模型字段。
- 待本次变更完成后运行 `npm test`、`git diff --check` 与安装校验；真实外部模型调用不在本地离线测试中执行。

## [0.2.2] - 2026-07-30

### 改动了什么

- Runtime Guard 的 JSON Schema 校验从自研子集校验改为 Ajv / ajv-formats，本地支持 Draft-07 与 Draft 2020-12 schema。
- 新增 `contracts/json-validation-error.schema.json` 与 `templates/json-regeneration-retry-prompt.md`，约束 JSON 校验失败日志和一次 JSON-only retry 提示。
- 所有内置工作 Agent、生成 Agent 模板和 manager 调度规则新增 JSON / JSONL 强校验要求：Agent 自检时校验，manager 在派发和接收边界再次校验。
- `validate-file` 失败输出增加 `validator: "ajv"`，可通过 `--log-file`、`--stage`、`--agent-id`、`--workflow-id`、`--task-id`、`--run-id`、`--attempt` 等参数记录错误主体和错误内容。
- 安装校验脚本增加 Ajv 依赖检查；README 与架构/契约/编排文档同步说明 `npm install`、Ajv validator、错误日志和 JSON-only retry。

### 为什么要改

- 让 JSON Schema 校验覆盖完整标准能力，避免自研子集遗漏 schema 语义。
- 防止 LLM 生成的 JSON 在 Agent 自检或 Agent 通信边界以“格式大致正确”通过。
- 在 JSON 失败时保留可追溯日志，并限制重试范围，避免一次格式修复被误做成重新分析或改变既有结论。

### 改后的效果

- 所有 JSON / JSONL 产物必须先本地 Ajv 强校验，再由 manager 在边界复检。
- 首次 JSON 校验失败只允许一次重试，且重试只能重新生成失败 JSON / JSONL，不得重新完整分析任务。
- 校验失败会保留结构化 JSONL 日志，包含失败主体、schema、validator errors、失败内容摘要、内容哈希、重试次数和最终状态。
- `runtime-guard self-check` 现在会用 Ajv strict mode 编译 contracts，并校验 19 个 contract 与 10 个模板。

## [0.2.1] - 2026-07-29

### 改动了什么

- 新增依赖 Node.js 标准库的无状态 Runtime Guard、工作流状态机、事件/审批/Gate 契约和对应模板。
- 文档补充 Guard 命令、fail-closed 边界、状态迁移、canonical 事件哈希、Gate 聚合与审批绑定规则。
- 收紧终态 current authority：终态 workflow 必须从 active index 移除并具有非空 final report；canonical serializer 对顶层与嵌套数字形态键按 Unicode 码点排序。
- 收紧 review/release lineage：finding 只按 current candidate 和可信 task event `seq` closure；ReleaseReadinessGate 精确绑定当前 release task/run 的唯一 decision、checks 与证据。
- 补强 current authority 边界：ReviewGate/SecurityGate 的 PASS 必须引用 current candidate 的合法 review-agent 证据；历史 release gate/decision 只校验自身 task/run，不参与当前候选或终态裁决，同 candidate 的旧 release rerun 也不能覆盖最新 release task/run；release 终态要求恰好一个最新 release task/run gate。

### 为什么要改

- 使控制快照、事件链、任务结果、审批和 Gate 在派发、合并、阶段推进、恢复与完成声明时得到同一套可执行一致性校验。
- 避免旧 candidate 的开放 finding、旧 release run decision 或 JavaScript 整数键重排错误夺取当前候选的权威；避免 FAIL/HOLD Gate 在缺少当前 release decision 时被接受。
- 避免 Review/Security Gate 在没有当前 review 的情况下仅凭旧证据 PASS，同时避免历史 release HOLD/NO_GO 或同 candidate 旧 rerun 与当前 release GO 终态相互冲突；避免最新 release task 尚无 gate/decision 时终态失去 verdict 约束。

### 改后的效果

- `manager-agent` 继续是唯一编排者和控制文件写入者；Guard 不充当 daemon、dispatcher 或第二控制平面。
- 无效状态迁移、快照/事件不一致、未决审批、开放阻断 finding 或 Gate/release verdict 不一致会 fail-closed。
- 后续 `RESOLVED` 可按可信 event `seq` 关闭同 candidate 的旧 `OPEN`，歧义则 HOLD；旧 candidate finding 与旧 release run 保留但不参与当前 Gate。
- Review/Security Gate 只有绑定 current candidate 的 review evidence 才能 PASS；历史 release artifact 保留并自洽校验，但不会覆盖最新 release task/run 的 verdict 或 workflow 终态；release 终态缺少最新 release gate 会 fail-closed。
- Release checks 以保守顺序重算：`HOLD`/`UNKNOWN`/`NOT_APPLICABLE` 优先为 `HOLD`，其后 `FAIL` 为 `NO_GO`，仅非空全 PASS 为 `GO`，空 checks 为 `HOLD`；decision/check evidence 限定当前 release task/run。
- 已提供 Node.js 测试；本机没有 `pwsh`，未在本机声明 PowerShell 测试通过。

## [0.2.0] - 2026-07-27

### 可插拔 Agent package 与审批式生成组件

#### 新增（Added）

- Agent/Skill package、组件申请和构建结果契约。
- `agents/packages/builtin/`：7 个内置 Agent 的只读 package manifest，不移动或修改原 workspace。
- `agents/packages/generated/`：新 Agent/Skill 的唯一可写与可删除区域。
- `scripts/manage-components.ps1`：审批式构建、注册、激活、停用和删除生成 Agent，以及 Skill Workshop 接入。
- `agent-package-manager` workspace Skill；Skill 内容创建直接复用 OpenClaw bundled `skill-creator`。
- 生成 Agent 安全模板、组件策略和完整操作文档。

#### 变更（Changed）

- PowerShell/Bash 安装与验证脚本改为扫描 package manifest，不再维护固定 Agent ID 数组。
- Manager `allowAgents` 根据 register/active/callable package 自动计算。
- 安装同步增加配置差异跳过、快照、失败恢复和 schema v2 安装清单。

#### 安全（Security）

- 内置 Agent 强制 `protected=true`、`deletable=false`，组件工具拒绝修改和删除。
- 新 Agent 默认未注册、未激活、无 binding、`allowAgents=[]`。
- 构建、激活、删除均要求与 component request 匹配的用户审批响应。
- Skill 只能应用到生成 Agent；本阶段不创建 MCP。

## [0.1.0] - 2026-07-23

### 架构重构（Native OpenClaw Architecture Rebuild）

本次为底层架构重构：**删除 OpenClaw 之外的 Python 控制平面**，将全部编排职责收归 `manager-agent`（依据固定文件协议 + OpenClaw 原生工具）。保留原有 7 个 Agent 的角色与主流程。

#### 新增（Added）

- 7 个原生 OpenClaw Agent 的完整 workspace prompt（`AGENTS.md` / `SOUL.md` / `TOOLS.md` / `IDENTITY.md`）。
- 共享规则集 `agents/common/`（通用规则、上下文协议、证据规则、Git 规则、审批规则、安全规则）。
- `manager-agent` 文件化控制层协议：workflow/task/run/decision/gate/approval/recovery。
- OpenClaw 原生跨 Agent 会话调度协议（`sessions_spawn` + 显式 `agentId`）。
- 12 个 JSON Schema 契约（`contracts/`）。
- 15 个模板（`templates/`）。
- PowerShell 与 Bash 的安装 / 验证 / 恢复脚本，默认 dry-run，绝对路径处理，System32/非项目 cwd 防护。
- 15 篇文档（`docs/`），含实测兼容性报告与威胁模型。
- 只读环境探测脚本 `scripts/preflight-probe.sh` 及其产物 `artifacts/preflight/`。

#### 移除（Removed）

- 任何 Python 控制平面 / 编排器 / dispatcher / 状态机 / Gate 引擎 / CommandRunner / recovery 服务 / daemon。
- `sdlcctl` 或任何同类运行时 CLI。
- 用于日常工作流执行的 `pyproject.toml` 与 Python 虚拟环境要求。

#### 说明（Notes）

- 本阶段仅到"运维前交付"，不做真实部署 / 远程发布 / CI-CD / 服务启停 / 生产迁移 / 生产凭证。
- 测试阶段无 sandbox，记录 `isolation_mode=UNSANDBOXED_LOCAL`，属已知安全限制。
- 探测到的 OpenClaw 版本：`2026.7.1-2 (0790d9f)`。详见 `docs/compatibility-report.md`。
