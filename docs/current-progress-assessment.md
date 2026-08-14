# 当前进度评估

> 评估日期：2026-08-14

## 结论

StateGraph/checkpointer 单框架重建已完成代码、规则、安装、测试和主要文档迁移。旧控制框架和 Java monitor 代理已删除；Node monitor、固定 dispatch、Git candidate、证据接收和 Docker TEST sandbox 均已进入主测试入口。

当前状态适合继续进行真实 OpenClaw/Docker 集成演练，但还不能宣称生产验收完成：本机 Docker Desktop Linux daemon 未启动，因此真实容器创建和完整 test-agent E2E 尚无本轮证据。

## 已完成

| 领域 | 当前实现 |
| --- | --- |
| 状态权威 | 最新 LangGraph checkpoint；SQLite checkpointer 持久化并带 SHA-256 事件链 |
| 动态路线 | Manager 提案，代码校验，人工确认后冻结 route hash/steps/approvals |
| 派发 | task kind 到 Agent 固定映射；dispatch node 是唯一调用入口 |
| 重试 | JSON 同 session 2 次；Agent 初次加 2 次自动重试；失败后人工升级 |
| Git | 每 run detached worktree；DEVELOPMENT/TEST commit ancestry 与 HEAD 绑定 |
| 结果接收 | raw 原文保留、Ajv、身份/路径/字节 SHA、CommandRecord/evidence 校验、原子发布 |
| TEST 隔离 | Docker fail-closed policy、动态 mount、runtime attestation、全局 lease 和异常恢复 |
| Manager 成本 | 200k context、32k output、60% soft budget、12k prompt 字符硬上限 |
| 安装 | 显式 checkpointer 依赖、模型目录同步、Windows DACL / Unix 0700 |
| 监控 | Node.js GET-only monitor、SSE、continuation、会话、artifact 和健康分类 |

## 重建与提交

- `d776149`：固化 StateGraph/checkpointer、worktree、manifest、Docker sandbox 和 Node monitor 基线。
- `77a58fc`：统一全部 worker 的 checkpoint/dispatch 可信边界。
- `2cc17ac`：删除旧控制框架、workflow runner 和 Java monitor 代理。
- `6976bff`：统一 200k 模型上限、安装模型目录同步和 raw artifact ACL。
- `c6b3b2f`：补齐候选 commit、证据 SHA、sandbox 异常恢复和 monitor 性能测试。

## 自动化验证

当前 `npm test` 覆盖：

- Runtime Guard：5 项；
- Agent JSON：12 项；
- runtime bundle：3 项；
- StateGraph：26 项；
- Node monitor：13 项；
- install validation：6 项。

StateGraph 新增覆盖包括完整 DEVELOPMENT/REVIEW/TEST/RELEASE candidate 链、TEST 修改推进 candidate、非法/非后代/HEAD 不匹配 commit、缺失或 symlink 引用、CommandRecord/evidence SHA、sandbox 并发、陈旧 lease 和异常 attestation 回滚。

Monitor 性能 fixture 为 500 workflows / 2000 tasks，本机 refresh 约 0.4 秒，测试预算 2.5 秒。

## 尚未完成

1. Docker daemon 启动后构建 `openclaw-test-node:22-slim`，执行真实 test-agent E2E，并保存 `docker inspect`、OpenClaw sandbox explain/list 和 Agent result attestation。
2. 使用真实 OpenClaw Gateway 完成一条含 DEVELOPMENT、REVIEW、TEST、RELEASE 和人工路线确认的业务 workflow。
3. 根据实际部署账户验证 Linux systemd、artifact `0700`、日志轮换和反向代理认证。
4. 生产使用前完成服务账户、备份、磁盘容量、告警和恢复演练。

## 风险判断

- 自动化 command-boundary 测试证明代码在 mock CLI 响应下 fail closed，但不替代真实 Docker daemon。
- SQLite checkpointer 设计目标是本机单写 workflow；不支持多主机分布式写入。
- runtime/human capability 与 artifact ACL 仍处于同 OS 账户信任模型；生产部署应使用专用服务账户。
- 历史报告可以保留旧架构语境，但不得作为当前运行说明或恢复步骤。

## 下一步验收顺序

1. 启动 Docker daemon并构建测试镜像。
2. 运行完整自动化与真实 test-agent E2E。
3. 运行真实 Gateway workflow，验证 checkpoint 恢复和路线/步骤审批。
4. 启动 Node monitor，验证 GET-only、SSE、窄屏/宽屏和长会话滚动。
5. 保存验收证据后再评估发布或部署。
