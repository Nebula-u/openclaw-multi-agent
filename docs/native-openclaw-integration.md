# OpenClaw 原生集成

> CLI/schema 探测基线：OpenClaw `2026.7.1-2 (0790d9f)`；原始证据与有效期见 `docs/compatibility-report.md`。

## 当前集成位置

OpenClaw 提供 Agent 注册、Session 存储、模型调用、Gateway 和 sandbox。Node Orchestrator 提供工作流状态、阶段路由、Worker 派发、结果校验、重试、审批通知和 Git 快照。

```text
User → Manager Session → .orchestrator/requests/*.json
                         ↓
                Node Orchestrator
                  ├─ SQLite Kernel
                  ├─ Git worktree/snapshot
                  └─ openclaw agent --agent <fixed-id> --session-id <fixed-id>
```

Manager 不使用 `sessions_spawn` 或 `sessions_send` 派发 Worker。即使 OpenClaw schema 提供这些能力，它们也不是当前工作流执行入口。

## Agent 注册与配置

安装器从 `agents/packages/builtin/*.json` 和已批准的 generated package 读取：

- 绝对 `workspace` / `agentDir`；
- 模型路由；
- `subagents` 空白名单；
- sandbox 与工具配置；
- register/active 生命周期。

已存在且路径兼容的 Agent 会更新受管理内容；同 ID 指向其他 workspace 时安装失败关闭，不覆盖用户 Agent。工作 Agent 不绑定用户 channel。Manager binding 只有在用户传入安装参数时才改变。

## Manager delegation 的兼容层

当前 package manifest 将 Manager 的 delegation 意图声明为 `off`。OpenClaw 配置枚举只接受 `suggest|prefer`，安装器因此写入：

```json
{
  "delegationMode": "prefer",
  "requireAgentId": true,
  "allowAgents": []
}
```

空 `allowAgents` 使原生派生不可用。`prefer` 仅是 schema 兼容值，不能解释为 Manager 负责调度。

## Sandbox

当前只有 test-agent 显式配置 `sandbox.mode=all` 和 Docker backend。Manager 使用无沙箱 gateway exec，但该能力受 OpenClaw per-Agent allowlist 和受安装器校验的 `manager-control` 入口双重约束：

- Manager：只允许该固定入口执行受控项目初始化、Git 初始化、已批准远程 clone/fetch 与本地 Git 生命周期；禁止 raw shell、解释器、push 和破坏性 Git 操作。
- test-agent：`workspaceAccess=none`、`exec.host=sandbox`、network none、只读 rootfs、drop ALL capabilities、资源限制。

Docker 镜像由部署环境预先提供。安装器不会自动安装 Docker，但配置和验证不会把缺失的 sandbox 描述为安全隔离已成立。

## 配置操作

安装器通过当前 CLI 支持的 `agents add`、`config get`、`config set`/`patch` 和 `config validate` 操作，先 dry-run 再 apply。它按 ID 查找 `agents.list` 真实索引，只修改目标 Agent 的受管理字段。

验证入口：

```text
openclaw agents list --json
openclaw config get agents.list --json
openclaw config validate --json
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
bash scripts/validate-install.sh --runtime-root runtime
```

`openclaw doctor --lint --json` 只用于人工观察；项目不运行 `doctor --fix`。

## Session 与事实边界

OpenClaw Session 保存对话、reasoning 和最终回复。SQLite Kernel 保存 workflow/task/execution/approval/notification/HR/snapshot 事实。Session 存活或文本不能推进 workflow，也不能代替 Kernel receipt、结构化结果或 Git commit 校验。

Worker Session 由 Orchestrator 使用固定 Agent ID 和确定性 Session ID 创建。Manager 只能读取与已提交请求同名的 receipt，并且只有 `ACCEPTED` receipt 才证明 workflow 已创建。

## 更新与重装

普通同步不要求停止 Gateway：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

完整安全重装只用于注册状态或受管理 runtime 损坏，并要求先手动停止 Gateway：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```
