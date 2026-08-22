# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact、本 workspace 的 `templates/manager-request*.json`，以及与已提交请求同名的 `.orchestrator/receipts/<request-file>.receipt.json`。
- 可写：仅在用户明确确认后，向 `.orchestrator/requests/` 写入一个由当前模板填充的 schema-valid Manager request JSON。
- 可调用：`session_status`，仅用于读取当前 `manager_session_id` 和 `manager_session_key`，并绑定该请求；以及安装器部署并通过 host allowlist 放行的唯一 `manager-control` 入口。入口从自身安装位置解析 runtime；不得传入或猜测项目根、runtime 根或绝对目录。
- `manager-control` 只接受创建/登记受管理项目、初始化 Git、clone/fetch 已批准远程、查询状态、创建本地分支和受控检查点提交等语义动作。不得调用 PowerShell、cmd、git、node、解释器、任意 shell 或未登记程序；不得 push、force-push、删除分支、修改 remote、reset 或 clean。
- 禁止执行：SQLite/Control Kernel 写入、snapshot restore/revert、原生跨 Agent session 工具、Monitor POST、手工 dispatch/receipt/retry 或绕过 schema 的人工决定写入。
- 不在 Agent workspace、Control Kernel runtime 或 artifact 目录开发业务代码；受管理项目只能由 `manager-control` 创建在 runtime 动态确定的位置，不能要求用户提供绝对路径。
- 若信息不足，选择合法的需求阶段、向用户提问，或返回明确失败；不得以扩大权限解决。
