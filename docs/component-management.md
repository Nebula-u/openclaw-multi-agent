# Agent package 与生成组件管理

> 适用范围：Agent package、生成 Agent、生成 Skill。当前不包含 MCP。

## 1. 目标与事实来源

Agent ID、workspace source、runtime 路径、能力、delegation、sandbox 和生命周期均来自 `agents/packages/` 下的 JSON manifest。安装脚本只解释 package，不维护固定 Agent ID 数组。

- 内置包：`agents/packages/builtin/*.json`
- 生成 Agent：`agents/packages/generated/agents/<id>/agent.json`
- 生成 Skill：`agents/packages/generated/skills/<slug>/skill.json`
- 策略：`config/component-policy.json`
- 契约：`contracts/agent-package.schema.json`、`skill-package.schema.json`、`component-request.schema.json`、`component-build-result.schema.json`（`New-BuildResult` 生成的构建结果对应此契约）

内置包只引用原来的 `agents/<id>/workspace`，不会移动或重写这些 workspace。

## 2. package 生命周期

`lifecycle.register` 控制是否同步到 OpenClaw；`lifecycle.active` 控制是否加入 Manager 的 `allowAgents`。`active=true` 时必须同时 `register=true`。

| register | active | 含义 |
|---|---|---|
| false | false | 已构建但未注册 |
| true | false | 已注册但 Manager 不能调用 |
| true | true | 已注册且 Manager 可以按能力选择并显式调用 |

安装脚本每次同步都会根据全部 active/callable package 重新计算 Manager 白名单。

## 3. 只读与删除边界

组件管理脚本同时执行下列检查：

1. 内置 manifest 必须位于 `agents/packages/builtin/`，且 `origin=builtin`、`protected=true`、`deletable=false`。
2. 生成 Agent 必须位于 `agents/packages/generated/agents/`，且 `origin=generated`、`protected=false`、`deletable=true`。
3. 生成 Agent 的 source workspace 必须位于其 package 内。
4. 生成 Agent runtime 必须位于 `<runtime>/agents/generated/`。
5. 更新和删除命令只接受生成 Agent。
6. Skill 只能应用到生成 Agent；不能应用到、更新或删除内置 Agent 的 Skill。

## 4. 审批文件

创建前由 Manager 生成 component request，并使用现有 approval request/response 协议取得 `BUILD` 选择。构建完成后，注册/激活/删除需要新的 decision 与 response：

- `REGISTER` 或 `KEEP_INACTIVE`
- `ACTIVATE`
- `DEACTIVATE`
- `DELETE`

审批文件的 `decision_id` 必须与 component request 一致；脚本不会接受命令行布尔开关代替用户审批。

## 5. PowerShell 命令

```powershell
# 只读
pwsh -File scripts/manage-components.ps1 -Command List
pwsh -File scripts/manage-components.ps1 -Command Validate

# 创建新 Agent；缺省只输出计划，加 -Apply 才写生成目录
pwsh -File scripts/manage-components.ps1 -Command NewAgent `
  -Request <component-request.json> `
  -ApprovalResponse <approval-response.json> `
  -Apply -Yes

# 注册但不激活
pwsh -File scripts/manage-components.ps1 -Command SetAgentState `
  -Id <agent-id> -State RegisteredInactive `
  -Request <post-build-request.json> `
  -ApprovalResponse <approval-response.json> `
  -Apply -Yes

# 激活；同步后 Manager allowAgents 自动包含该 ID
pwsh -File scripts/manage-components.ps1 -Command SetAgentState `
  -Id <agent-id> -State Active `
  -Request <activation-request.json> `
  -ApprovalResponse <approval-response.json> `
  -Apply -Yes

# 删除生成 Agent
pwsh -File scripts/manage-components.ps1 -Command RemoveAgent `
  -Id <agent-id> -Request <delete-request.json> `
  -ApprovalResponse <approval-response.json> `
  -Apply -Yes
```

删除时先将 Agent 从 Manager 白名单移除，再调用 `openclaw agents delete`，最后删除生成 package。审计墓碑保留在 `<runtime>/control/generated-components.json`。

## 6. Skill Creator 与 Workshop

本机 OpenClaw 已提供成熟的 bundled `skill-creator`，Manager 应直接使用它在 `agents/packages/generated/skills/<slug>/` 生成并验证 `SKILL.md`。项目不复制、不 fork、不重复实现 Skill Creator。

生成完成后通过组件脚本调用原生 Workshop：

```powershell
pwsh -File scripts/manage-components.ps1 -Command ProposeSkill `
  -TargetAgent <generated-agent-id> `
  -Request <component-request.json> `
  -ApprovalResponse <build-approval-response.json> `
  -Apply -Yes

pwsh -File scripts/manage-components.ps1 -Command ApplySkill `
  -Id <skill-slug> -ProposalId <proposal-id> `
  -TargetAgent <generated-agent-id> `
  -Request <activation-request.json> `
  -ApprovalResponse <activation-approval-response.json> `
  -Apply -Yes
```

`ProposeSkill` 要求目标生成 Agent 已注册但未必激活；`ApplySkill` 要求第二次审批。未应用 Skill 可直接保留为生成包，或经 `RemoveSkill` 命令、`DELETE` 审批删除：

```powershell
pwsh -File scripts/manage-components.ps1 -Command RemoveSkill `
  -Id <skill-slug> -TargetAgent <generated-agent-id> `
  -Request <delete-request.json> `
  -ApprovalResponse <delete-approval-response.json> `
  -Apply -Yes
```

## 7. Bash 支持

`install.sh` 与 `validate-install.sh` 已改为读取相同 package manifest，支持静态 package 的发现、同步与验证。审批式内容生成和破坏性删除以 PowerShell 实现为权威入口；Bash 不会绕过该边界自行删除组件。

## 8. 后续 LangGraph 接入

后续可把 `List/Validate/NewAgent/SetAgentState/RemoveAgent` 封装成 LangGraph 节点或工具。package manifest 和审批协议保持不变，不需要再次迁移 Agent。
