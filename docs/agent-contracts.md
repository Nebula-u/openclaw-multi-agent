# Agent 运行契约

## 通用边界

每个 worker 只接受 Orchestrator 创建的 task。task 固定绑定 workflow、step、run、Agent、attempt、input commit、worktree、artifact root 与 context manifest。

Agent 必须核对身份、路径和 manifest SHA，只完成被分配步骤；不得调用其他 Agent、写 Control Kernel、改变路线或审批、操作 Monitor，也不得替用户做决定。

## 结构化结果

worker 完成任务后最终回复只能是一个符合 `contracts/result.schema.json` 的对象。Orchestrator 从最终回复提取 JSON，原子写入 `<artifact_root>/.agent-raw/result.json.raw`，再校验 schema、workflow/task/run/Agent/attempt、worktree、artifact root、input commit 与 context manifest SHA，最后发布到 `output/result.json`。

`result_status`：`COMPLETED`、`NEEDS_REWORK`、`BLOCKED`、`HUMAN_DECISION_REQUIRED`、`FAILED`。非完成结果仍会捕获 recovery snapshot，但不会作为成功候选推进。

## Git

只有 developer-agent 和 test-agent 可以在授权 worktree 中修改并正常提交。其他角色只能发布 artifact/结构化结果，目标仓库必须保持 `NO_CHANGE`；即使任务涉及业务文档，也应路由给 Developer/Test 修改。宿主而非 Agent 决定快照是否可信：验证 commit 存在、血缘、HEAD 和 clean 状态，并重新计算文件 diff。Agent 不创建 `refs/openclaw/snapshots/*`。

失败或脏 worktree 可能由宿主生成 recovery commit。Restore/Revert 只能通过宿主 CLI 执行；Agent 禁止用 `reset --hard` 代替回滚。

## 角色

- requirement-agent：范围、边界、验收标准；
- architect-agent：架构/设计、接口、风险和测试策略；
- developer-agent：实现并提交代码；
- test-agent：执行/补充测试并保存真实证据；
- review-agent：绑定候选 commit 审查；
- release-agent：完成发布前检查、共享基础域名路径分配、经二次人工确认后的受控部署及上线验证；不做代码审查；
- manager-agent：只在原始用户 Session 中解释路线和收集决定；
- hr-agent：手动优先、只读脱敏 dossier，只检查三类边界问题；输出必须是严格 JSON findings，不创建文件或 commit。

## Session 与重试

Orchestrator 为每个 task/attempt 生成确定性 Session ID，并为每个 retry attempt 创建新的 worktree。OpenClaw 保存对话，SQLite execution/snapshot 记录其绑定。Agent 不能自行更换 Session 或把其他 Session 产物冒充为当前任务结果。执行期间宿主周期续租；租约所有权丢失会中止 Agent，避免过期执行与新 attempt 并发写入。
