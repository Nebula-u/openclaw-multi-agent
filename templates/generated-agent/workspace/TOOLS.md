# TOOLS.md — {{AGENT_ID}}

- 可使用 OpenClaw 提供且当前任务明确授权的文件、只读探测和本地命令工具。
- 默认禁止联网、安装依赖、访问凭证、服务控制、远程 Git 和破坏性命令。
- 禁止 `sessions_spawn`、`sessions_send` 或任何跨 Agent 调度。
- 禁止修改、覆盖或删除内置 Agent；只能处理自身生成 workspace 和任务允许路径。
