# Agent 边界、运行态与信息流审计及当前未完成问题

- 审计时间：2026-08-07T02:40:47Z（UTC，Asia/Shanghai 为 10:40:47）
- 审计范围：本仓库、`runtime/control/control.db`、`runtime/monitor/monitor.db`、本机 OpenClaw 配置和会话索引。
- 结论口径：本文件记录该时间点仍未解决的问题；状态、告警和看板均以控制库与本地采集器为准，不能以 Agent 的聊天陈述为准。

## 运行态快照

| 项目 | 观测值 | 事实来源 |
| --- | --- | --- |
| Control Kernel | 4 个 workflow，全部 `TERMINAL/QUARANTINED`；task、dispatch、dispatch outbox 和监督请求均为 0 | `runtime/control/control.db`，`control-kernel snapshot` |
| Monitor | `monitor_events`、`agent_activities`、`agent_health_snapshots`、`session_cursors`、`artifact_cursors` 均为 0 | `runtime/monitor/monitor.db` |
| Monitor 进程 | `node monitor/supervisor.mjs` 正在监听本机 4319 | OS 进程表 |
| OpenClaw 会话 | manager-agent 2 个已结束会话；developer-agent 2 个已结束子会话；test-agent 0 个会话 | `openclaw sessions list --agent <id> --json` |
| 配置路由 | 默认 `main` workspace 指向另一项目；没有 manager binding；manager-agent 虽已安装但不是默认入口 | `%USERPROFILE%/.openclaw/openclaw.json`（仅读取非秘密字段） |

因此，当前看板为空不是 Supervisor 未启动，而是实际 manager/developer 会话从未形成 Control Kernel 的 task/dispatch 记录；session tailer 按 dispatch 关联会话，无法将这些孤立会话归属到 workflow。

## 审计发现与本次代码整改结果

| 优先级 | 问题、绕过点与影响 | 当前事实源 / 信息传递 | 整改结果 |
| --- | --- | --- | --- |
| P0 | **派发由 LLM 决定。** manager 规则仍要求它自行调用 `sessions_spawn`、写 receipt，并存在 v1/v2 直接控制文件说明。影响：无可追溯 dispatch、重复派发和看板失明。 | 当前仅有 Agent 原生会话；Control DB 无对应记录。 | **已代码整改**：`orchestrator dispatch` 从 READY task 固定派生 worker、session、intent/receipt/completion；manager/workers 规则已禁止原生派发。 |
| P0 | **控制写入者身份可伪造。** `actor` 只是 JSON 字段。 | `control-kernel.mjs`、repository。 | **已代码整改**：Control Kernel mutation 要求 local capability，并把 actor 固定派生为 `local-orchestrator`；仍受同 OS 账户权限限制，见下节。 |
| P0 | **结构化输出有多条清洗路径。** | `json-ingestion.mjs`、Task Repository、PowerShell 包装器。 | **已代码整改**：新 task 强制 `LOCAL_STAGED`；`.agent-raw → ingestJsonText → Ajv → 原子发布 → ingestion receipt` 是唯一 Agent 结果路径。 |
| P1 | **看板可交互且展示工具活动。** | Monitor HTTP、session tailer、UI。 | **已代码整改**：删除公共 POST/activity 与 supervision 路由、表单和工具事件；公共快照去除路径/session/控制细节，只保留用户安全对话。 |
| P1 | **worker 委派白名单未物化。** | OpenClaw effective `agents.list`。 | **已部署整改**（2026-08-07T03:07Z 后）：6 个 worker 全部为显式 `subagents.allowAgents=[]`；安装脚本新增“缺字段也必须写入”校验。 |
| P1 | **临时开发路径可能绕过工作流。** | 目录策略与历史隔离 workflow。 | **已代码/规则整改**：仅允许 `runtime/worktrees/<workflow>/<task>/<run>/repo`，Agent workspace/control/artifact 不能作为代码复制中转区。 |
| P2 | **dialogue-agent 注册漂移。** | package catalog 与实际 config。 | **已代码整改**：包已改为 `register=false`、`active=false`。 |

## 当前仍未完成（2026-08-07T03:29:31Z）

| 优先级 | 未完成项、影响 | 事实源 | 需要的后续动作 |
| --- | --- | --- | --- |
| P0 | **没有活动 v2 workflow/task/dispatch。** Control DB 仍只有 4 个隔离 tombstone；此前 manager/developer 会话不可被事后安全地补绑。因此看板现在仍应为空。 | `control-kernel snapshot`、monitor DB 均为 0。 | 用 `orchestrator apply → task-register → task-validate → dispatch` 新建一次真实任务；只有此路径会产生实时 Agent 状态与对话。 |
| P0 | **用户入口尚未路由到 manager-agent。** 现有默认 `main` 指向另一项目，且没有本项目 manager binding。影响：新用户消息仍可能进入旧项目，完全不产生本项目 workflow。 | `%USERPROFILE%/.openclaw/openclaw.json`。 | 这是会改变其他项目行为的选择：明确指定 channel binding，或显式运行安装脚本的 `-SetManagerAsDefault`。不能安全地自动替换。 |
| P1 | **主机最小权限尚未部署。** `test-agent` 仍是 `sandbox.mode=off`，worker 仍继承全局 coding/web 工具；同一 Windows 登录账户可读取 capability 或直接执行 Orchestrator。影响：代码协议不能替代 OS 隔离。 | OpenClaw effective config、宿主进程权限。 | 以独立服务账户运行 Orchestrator，设置 capability/runtime ACL，并按已验证的 OpenClaw tool schema 为每个 worker 配 allow/deny；若保留 test 无 sandbox，需单独风险批准。 |
| P1 | **Gateway 可能尚未重载首个配置变更。** OpenClaw 在写入首个 worker `subagents` 时提示需重启 Gateway。 | OpenClaw CLI mutation 回执；`config validate` 已通过。 | 在无活动会话窗口重启 Gateway，然后创建一个小任务验证 worker 无法 delegation、Monitor 可见状态。 |

## 本次整改验证（2026-08-07T03:29:31Z）

| 验证项 | 结果 | 事实来源 |
| --- | --- | --- |
| 控制状态 | 仍为 4 个 `TERMINAL/QUARANTINED` 历史 workflow，尚无 v2 task/dispatch；未把旧会话伪造为新工作流。 | `node scripts/control-kernel.mjs snapshot --project-root .` |
| OpenClaw 配置 | 配置有效；manager 的 allowlist 恰为 6 个已注册 worker，6 个 worker 的 allowlist 均为空。`test-agent` sandbox 仍为 `off`，已保留为未完成部署风险。 | `openclaw config validate --json`、`openclaw config get agents.list --json` |
| Runtime bundle | 105 个受管条目完整且校验通过。 | `node scripts/runtime-bundle.mjs verify --project-root . --runtime-root runtime` |
| 自动测试 | 171 通过、0 失败；2 个 runtime-guard 符号链接用例因当前 Windows 账户没有创建符号链接权限而跳过。 | `test:runtime-guard`、`test:agent-json`、`test:runtime-bundle`、`test:control-kernel`、`test:monitor`、`test:legacy-migration`、`validate-install` |

## 目标信息流（整改后）

```text
用户请求 → 本地 workflow/Control Kernel → 已验证 task
         → 本地 Orchestrator（固定 Agent ID、会话、回执）
         → OpenClaw Agent
         → staged raw 结构化输出
         → 本地统一 JSON 入库/校验/原子发布
         → Control DB
         → Monitor session tailer + artifact watcher + health classifier
         → 只读用户看板
```

信息由 Agent 产生的仅是自然语言可见输出、代码变更和 staged raw 产物；是否接受、进入何阶段、是否重试、派给哪个 Agent、所有状态/回执和看板事实均由 workflow 或本地代码决定。Agent 的内部思考不采集、不持久化、不对用户展示。

## 仍需部署侧完成的前提

代码可阻止协议绕过，但不能在同一 Windows 登录账户下替代文件 ACL、进程隔离或 OpenClaw 的工具沙箱。worker `allowAgents=[]` 已落地；仍需由部署账户为 runtime/control capability、OpenClaw 配置和 worker worktree 设置最小权限。默认入口或 binding 是行为变更，安装脚本保持显式开关，不会静默替换现有 `main`。
