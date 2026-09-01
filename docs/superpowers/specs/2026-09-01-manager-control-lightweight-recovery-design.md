# 轻量化 Manager 工作流恢复设计

## 目标

让 Manager 在不放宽 `exec` allowlist、不新增 Gateway 插件的前提下，安全查询同一会话最近的工作流，并使用安装器提供的唯一受控入口。

## 设计

安装器继续只向 `manager-agent` 的 host exec allowlist 写入一个规范化的 `manager-control` 文件路径。安装完成后，它将该已验证路径写入 Manager 的部署版工具说明；Manager 只能逐字调用该路径，不能使用裸 `manager-control`、shell 链、解释器或自行推导的 runtime 路径。

`manager-control` 新增只读动作 `orchestrator-current-status`。该动作仅接收 `--manager-session-key`，根据完全相等的 key 在 Control Kernel 中选择最新更新的 run；若数据库没有匹配 run，则在 Manager 请求队列中选择同 key 的最新有效请求。它只返回该 workflow 的既有状态视图，并补充原始需求和 `project_ref`；找不到时返回 `WORKFLOW_NOT_FOUND`。既有 `orchestrator-status`、审批和暂停/恢复动作继续要求完整的 workflow 与双 session 绑定，不改变其权限边界。

## 约束

- 不允许 shell、Node、PowerShell、裸命令名、通配 allowlist 或任意命令文本。
- `orchestrator-current-status` 是只读的，且不能读取其它 session key 的 workflow。
- Windows 与 Linux 都必须通过安装器生成的精确入口调用；Windows 使用 `.cmd`，Linux 使用无扩展名 launcher。
- 已安装 Agent 需要使用普通安装器更新；不需要停止 Gateway。
