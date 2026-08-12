# 轻量 StateGraph + Supervisor + Monitor 实施总结

> 日期：2026-08-12  
> 分支：`codex/lite-stategraph-supervisor`  
> 状态：可独立发布，未合并到主分支

## 修改了什么

1. 将 LangGraph `StateGraph` 接入 SQLite checkpointer。checkpoint 与 pending writes 保存在现有 `runtime/control/control.db`，`workflow_id` 作为 Graph `thread_id`。业务状态仍以 workflow/task/run/dispatch 表为权威，checkpoint 不复制或替代业务事实。
2. 将 Supervisor 改为 checkpoint-aware 的事件驱动监工。它对账 detached worker 结果后执行有限个固定 Graph turn，仅在 `NEEDS_TASK`、`HOLD`、`FAILED` 等需要 Manager 判断的位置唤醒 Manager，并在只读 `/api/supervisor` 中公开恢复位置。
3. 工作 Agent 的进程、dispatch lease、工具执行宽限和 JSON 契约调用上限统一调整为 900 秒。Manager wake 和健康检测仍使用更短上限，避免监督链路随工作 Agent 一起等待 15 分钟。
4. 新增持久 Agent 会话目录：合并 package 清单与 OpenClaw session 根目录，列出所有已创建 Agent、全部 session、状态、模型、token 与运行时信息。会话正文只输出 user/assistant 文本，过滤 reasoning、thinking、toolCall、toolResult、system prompt 和敏感字段。
5. Monitor 控制台新增完整对话组件：左侧竖向显示所有 Agent（包括未激活和已结束），右侧可切换 session 并显示最近 500 条完整安全对话。原有 workflow、阶段、task、健康状态和 SSE feed 保留。
6. 删除已被新会话控制台替代的 task/Agent 摘要 activity HTTP 路径和任务弹窗重复摘要列表。session tailer 继续用于实时健康信号和 SSE；Control Kernel、dispatch receipt、审批、幂等、投影恢复和 detached launcher 继续作为兼容/可靠性边界。

## 为什么这样修改

旧方案同时让 Manager 承担状态判断、频繁轮询和长任务等待，容易扩大上下文并把“宿主等待超时”误判为“Agent 未完成”。本次将可确定的状态切换收敛到代码，把长任务交给可恢复 worker，把 Graph 位置与业务事实持久化到 SQLite。Manager 只处理无法由规则决定的事项，因此上下文更小，也不再依赖持续人工催促才能推进。

Monitor 原先只保存助手摘要，无法确认子 Agent 的真实会话是否已结束，也无法切换历史 session。新的目录直接读取 OpenClaw 已持久化的 session 索引和 JSONL，在不暴露私有推理或工具细节的前提下提供完整对话证据。

## 带来的作用

- Supervisor 或 Manager 进程重启后可以从 checkpoint 与业务事实恢复，不需要重新播放完整聊天上下文。
- 900 秒上限适合当前小型项目的架构、开发与测试任务，并通过 detached dispatch 避免宿主等待时间决定任务成败。
- 固定状态机、合法边校验、幂等 dispatch 和结果 Schema 校验继续阻止 Agent 自行越级改状态。
- 运维人员可在一个只读界面中找到所有 Agent，判断其运行/结束状态，切换 session，并核对完整公开对话。
- 兼容层分阶段保留，现有安装、worker、审批、产物摄取、审计和恢复流程无需一次性迁移。

## 安全与兼容边界

- Monitor API 仍只接受 loopback 与允许的 Origin，不提供写操作。
- 对话 API 不返回 thinking/reasoning、工具调用、工具结果、系统消息、prompt 或凭据；文本经过统一脱敏和长度限制。
- 本轮未删除 runtime 数据、历史快照或用户 session 文件，也未合并主分支。
- `runtime/control/v2/**` 投影暂时保留，因为安装校验、审计恢复和既有运维文档仍有消费者；待这些消费者迁移后才能单独删除。

## 验证结果

- Graph/checkpointer/Supervisor/Monitor 定向回归共 55 项通过，0 失败。
- Monitor 页面通过无构建依赖、CSP、API 路径静态测试，并完成一次本地实际渲染检查。
- `git diff --check` 通过。
- 完整 `npm test` 及包含旧 Runtime Guard/Control Kernel 大套件的组合命令均触达本项目规定的 300 秒宿主上限，未产生断言失败输出；终止后残留的测试子进程已按进程树清理。该限制不放宽到 5 分钟以上。

## 提交分轮

- `d0c4563`：SQLite Graph checkpoint。
- `7bd704e`：Agent 900 秒执行边界。
- `40d429c`：checkpoint-aware Supervisor。
- `e199c84`：持久 Agent/session/对话 API。
- `ae63dbd`：Agent session 对话控制台。
- `2641b75`：移除重复摘要对话路径。
