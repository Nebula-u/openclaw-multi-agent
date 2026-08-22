# OpenClaw 当前配置说明

本文件记录当前项目实际使用的 OpenClaw 配置边界。CLI/schema 的原始探测快照见 `docs/compatibility-report.md`；当前运行架构以 `README.md`、`docs/architecture.md` 和实际 package manifest 为准。

## 1. 调度边界

Manager 只与用户对话并写入 schema-valid Manager request。Node Orchestrator 消费请求、固定阶段到 Agent 的映射并通过 `openclaw agent --agent --session-id` 启动 Worker Session。

Manager 不调用 `sessions_spawn`、`sessions_send` 或其他原生跨 Agent 派发工具。Worker 也不得派生其他 Agent。

## 2. Agent 注册

`scripts/install.ps1` 和 `scripts/install.sh` 从 package catalog 读取所有 `register=true` 的 Agent，为每个 Agent 配置绝对 `workspace` 与 `agentDir`。普通更新只同步受管理字段和 workspace，不覆盖用户无关 Agent。

当前版本实测支持：

```text
openclaw agents add [name]
  --workspace <dir>
  --agent-dir <dir>
  --model <id>
  --bind <channel[:accountId]>
  --non-interactive
  --json
```

Manager 是否成为默认 Agent、是否绑定用户渠道，只由安装参数 `-SetManagerAsDefault` / `-ManagerBinding` 显式控制。

## 3. delegation 兼容表示

package manifest 用 `delegation_mode=off` 表达 Manager 不承担派发职责。当前 OpenClaw 配置 schema 的 `delegationMode` 只接受 `suggest|prefer`，因此安装后的等效配置是：

```json
{
  "subagents": {
    "delegationMode": "prefer",
    "requireAgentId": true,
    "allowAgents": []
  }
}
```

这里真正的权限门闩是 `allowAgents=[]`。`prefer` 只是满足 OpenClaw 枚举约束的兼容值，不赋予 Manager 派发能力。所有 Worker 同样显式使用空白名单。

## 4. sandbox 与工具

- `manager-agent`：`sandbox.mode=all`，Docker backend，workspace 可写；只允许读取和写入受控请求文件所需的最小文件工具，拒绝 shell、跨 Agent message 和外部访问。
- `test-agent`：`sandbox.mode=all`，Docker backend，`workspaceAccess=none`，`exec.host=sandbox`，network none、只读 rootfs、drop ALL capabilities、非 root 和资源限制。
- 其他 Worker：按 package manifest 配置；所有 Worker 的 Agent 派生白名单为空。

test-agent 使用的 Docker 镜像是运行前置。安装脚本只配置现有环境，不自动安装 Docker。

## 5. 配置写入纪律

安装器先读取 `agents.list` 并按 Agent ID 定位真实数组索引，再对目标字段执行 dry-run、apply 和 `openclaw config validate --json`。不得盲目替换整个 `agents.list`。

普通更新：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

普通更新不需要停止 Gateway。只有注册状态或受管理 runtime 损坏、普通更新无法修复时，才在手动停止 Gateway 后执行完整安全重装：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

## 6. 明确不做

- 不执行 `openclaw doctor --fix`。
- 不删除或重置用户无关 Agent、认证、会话或 workspace。
- 不以 Manager 原生子 Agent 会话替代 Node Orchestrator。
- 不退回相对 workspace/agentDir 或 Python 控制平面。

## 7. 工具结果预算

当前配置使用 `agents.defaults.contextLimits.toolResultMaxChars=12000` 限制单次工具结果注入。需要完整内容时应使用目标查询或分段读取。该设置不改变模型路由。
