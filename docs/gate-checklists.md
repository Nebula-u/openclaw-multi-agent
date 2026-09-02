# 本地接收与检查清单

Agent 自检是候选信息，不能替代宿主检查。当前 Orchestrator 在接受结果时至少执行：

- result JSON 可确定性解析并通过 schema；
- workflow/task/run/Agent/attempt 身份一致；
- worktree、artifact root、input commit 和 manifest SHA 一致；
- 引用路径不逃逸授权根且不是 symlink；
- `COMPLETED` 的 output commit 存在、基于 input、等于 HEAD，worktree clean；
- 真实变更清单由宿主 Git 计算。

各角色仍必须提供与阶段相符的证据：需求的范围/验收、架构的约束/风险、开发的实现与验证、测试的命令和失败、Review 的 commit 绑定、Release 的回滚与发布准备。缺少这些内容应返回 `NEEDS_REWORK`、`BLOCKED` 或 `FAILED`，不能用模糊的 `COMPLETED` 掩盖。

若结果不能接收，Orchestrator 写 failure receipt、释放 execution lease、捕获 recovery snapshot 并按 attempt 上限处理。人工审批不能绕过 schema、身份或 Git 校验。
