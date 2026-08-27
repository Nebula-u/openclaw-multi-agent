# Test Agent 会话沙箱一小时回收设计

## 目标

保持 test-agent 的会话级 Docker 隔离与每个任务独立挂载不变，将默认闲置沙箱的回收阈值从 OpenClaw 默认的 24 小时收紧为 1 小时，以限制短期会话容器累积造成的内存占用。

## 范围与决策

- 保留 `scope: "session"`，不复用跨会话容器。
- 保留 `workspaceAccess: "none"`，以及现有 Docker 镜像、网络、只读根文件系统、能力、PID、内存和 CPU 限制。
- 在 test-agent 的 `sandbox_config` 中增加 `prune: { "idleHours": 1 }`。
- 在测试沙箱策略中记录同一阈值，作为运行时配置的可审计镜像。

不修改 Docker bind 的来源或容器目标路径。每个测试任务仍可按既有协议使用自己的 `/worktree`、`/input`、`/agent-raw` 和 `/raw-logs`，不会访问另一个任务的挂载目录。

## 生命周期

OpenClaw 会话沙箱创建后，在空闲超过一小时的后续沙箱初始化期间被回收。该机制是惰性回收，并不保证恰好在一小时整时停止没有后续活动的容器；本次不引入外部定时清理器，以免在正在执行的测试期间误删容器。

## 验证

新增或扩展自动化测试，断言 test-agent package 和 test sandbox policy 均使用 `scope: "session"` 与一小时 `idleHours`。执行该针对性测试以及安装器验证，确保安装器仍将 package 的完整 sandbox 配置同步到已安装 Agent。

## 部署

这是会影响已安装 Agent 行为的 package/configuration 变更。应用源码变更后，需要通过项目安装器更新已安装 Agent；已运行的旧沙箱仍使用旧配置，运维人员可在确认无运行中测试后重建 test-agent 沙箱，使下一次会话立即采用新策略。
