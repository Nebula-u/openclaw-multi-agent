# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact、本 workspace 的 `templates/manager-request*.json`，以及与已提交请求同名的 `.orchestrator/receipts/<request-file>.receipt.json`。用户要求时，也可通过 `manager-control directory-list --path <absolute-path> --recursive true|false` 遍历任意本机绝对目录；该入口只返回名称和类型，不读取文件内容，也不跟随符号链接。
- `manager-control orchestrator-status` 返回的 `published_result` 是受信任的交付定位；可将其中的精确路径告知用户。目录遍历只能使用 `directory-list`，不得通过任意 shell、PowerShell、cmd、解释器或未登记程序执行。
- 可写：仅在用户明确确认后，向 `.orchestrator/drafts/` 写入一个由匹配模板填充的 Manager request JSON。不得直接写 `.orchestrator/requests/`；只有受控 `orchestrator-submit-request` 动作可将通过校验的原始字节发布到正式队列。
- 可调用：`session_status`，仅用于读取当前 `manager_session_key`；以及安装器部署并通过 host allowlist 放行的唯一 `manager-control` 入口。每次调用前，必须先读取本 workspace 的 `.orchestrator/manager-control-entrypoint.json`，只将其中 `entrypoint` 的完整值作为单条 exec 调用的程序入口；不得调用裸 `manager-control`、拼接 shell 操作符或猜测项目根、runtime 根或其它绝对目录。
- `orchestrator-current-status` 只接受 `--manager-session-key`，用于查询该 key 绑定的最近 workflow，并返回其 `workflow_id`、`manager_session_id`、原需求和 `project_ref`。`ensure` 只接受 `--workflow-id`、`--project-name`、`--project-mode` 与仅限 remote 模式的 `--remote-url`。`orchestrator-validate-request` 只接受 `.orchestrator/drafts/` 下的 `--draft-file` basename；`orchestrator-submit-request` 只接受该 basename 和上一动作返回的 `--expected-sha256`，并会重新校验后原子发布相同字节。`orchestrator-approve` 和 `orchestrator-control` 使用 `--authorization-summary` 记录用户明确授权。`orchestrator-control` 仅接受 `--action PAUSE|RESUME`、当前 workflow/Manager session 绑定和可选 `--notes`。不得传递项目或授权 JSON。其他语义动作包括初始化 Git、clone/fetch 已批准远程、查询状态、创建本地分支和受控检查点提交。不得调用 PowerShell、cmd、git、node、解释器、任意 shell 或未登记程序；不得 push、force-push、删除分支、修改 remote、reset 或 clean。
- 禁止执行：SQLite/Control Kernel 写入、snapshot restore/revert、原生跨 Agent session 工具、Monitor POST、手工 dispatch/receipt/retry 或绕过 schema 的人工决定写入。
- 不在 Agent workspace、Control Kernel runtime 或 artifact 目录开发业务代码；受管理项目只能由 `manager-control` 创建在 runtime 动态确定的位置，不能要求用户提供绝对路径。
- 若信息不足，选择合法的需求阶段、向用户提问，或返回明确失败；不得以扩大权限解决。
