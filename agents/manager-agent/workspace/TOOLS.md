# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact、本 workspace 的 `templates/manager-request*.json`，以及与已提交请求同名的 `.orchestrator/receipts/<request-file>.receipt.json`。用户要求时，也可通过 `manager-control directory-list --path <absolute-path> --recursive true|false` 遍历任意本机绝对目录；该入口只返回名称和类型，不读取文件内容，也不跟随符号链接。
- `manager-control orchestrator-status` 返回的 `published_result` 是受信任的交付定位；可将其中的精确路径告知用户。目录遍历只能使用 `directory-list`，不得通过任意 shell、PowerShell、cmd、解释器或未登记程序执行。
- 可写：仅在用户明确确认后，向 `.orchestrator/requests/` 写入一个由当前模板填充的 schema-valid Manager request JSON。
- 可调用：`session_status`，仅用于读取当前 `manager_session_id` 和 `manager_session_key`，并绑定该请求；以及安装器部署并通过 host allowlist 放行的唯一 `manager-control` 入口。入口从自身安装位置解析 runtime；不得传入或猜测项目根、runtime 根或绝对目录。
- `manager-control ensure` 只接受 `--workflow-id`、`--project-name`、`--project-mode` 与仅限 remote 模式的 `--remote-url`；`orchestrator-approve` 和 `orchestrator-control` 使用 `--authorization-summary` 记录用户明确授权。`orchestrator-control` 仅接受 `--action PAUSE|RESUME`、当前 workflow/Manager session 绑定和可选 `--notes`。不得传递项目或授权 JSON。其他语义动作包括初始化 Git、clone/fetch 已批准远程、查询状态、创建本地分支和受控检查点提交。不得调用 PowerShell、cmd、git、node、解释器、任意 shell 或未登记程序；不得 push、force-push、删除分支、修改 remote、reset 或 clean。
- 禁止执行：SQLite/Control Kernel 写入、snapshot restore/revert、原生跨 Agent session 工具、Monitor POST、手工 dispatch/receipt/retry 或绕过 schema 的人工决定写入。
- 不在 Agent workspace、Control Kernel runtime 或 artifact 目录开发业务代码；受管理项目只能由 `manager-control` 创建在 runtime 动态确定的位置，不能要求用户提供绝对路径。
- 若信息不足，选择合法的需求阶段、向用户提问，或返回明确失败；不得以扩大权限解决。
