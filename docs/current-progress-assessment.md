# 当前进度评估

> 评估日期：2026-08-21

## 当前实现

- Control Kernel 已改为单机 SQLite，默认 `runtime/control/kernel.db`；
- PostgreSQL 依赖、StateGraph 历史迁移、revision CAS、事件表/哈希链和 artifact CAS 副本已退出活动实现；
- Git worktree + hidden ref 保存 accepted/no-change/failed-recovery/restore/revert 快照；每个 retry attempt 使用独立 worktree，Revert 校验当前 HEAD 祖先关系；
- snapshot 可按 Agent/Session 查看，原 worktree 清理后仍从目标仓库读取 diff；
- HR 可按 Session 读取脱敏 reasoning、最后输出和真实 Git 修改，只检查三类边界问题；
- HR 默认手动，保留 task/daily/both 自动接口；跨 trigger 按 snapshot + Session 去重，输出只接受三类结构化 findings；
- Monitor 使用只读 Kernel 连接并展示 workflow、普通 Agent Session、校验后的 HR findings 和 Git snapshot；HR 原始 Session 不公开；
- 所有 Kernel 写入口共用单写者锁；只读 CLI 不创建数据库；Git/SQLite 索引失败使用轻量补偿，不引入事件链或分布式事务框架。

## 部署边界

只支持单机本地磁盘。用户并发由同一 OpenClaw Gateway/Orchestrator 处理，不需要多台服务器共享 SQLite。若未来需要多机写入，必须重新评估服务器数据库与分布式协调。

新版本从空 SQLite 开始，不迁移旧数据库或 checkpoint 历史。Git 与 SQLite 没有跨资源 ACID；代码灾备必须在一致性窗口内同时保存 Kernel、目标 Git 仓库和 artifacts。

## 验收

仓库的最终验收以当前 `npm test`、安装 dry-run、validate 脚本与 `git diff --check` 的新鲜结果为准，不引用旧进度报告中的测试数量。真实服务器部署后仍应补一次 OpenClaw Gateway、Agent Session 目录、Git restore/revert 和定时调度的端到端演练。
