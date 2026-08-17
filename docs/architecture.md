# StateGraph + Checkpointer 架构

> 更新日期：2026-08-14

## 设计结论

项目只保留 LangGraph `StateGraph + checkpointer` 作为 workflow 框架。重建基点为 `ef850ce6e8b71391203460f28670b1d85eb72c72`：该提交位于已知混淆 JavaScript 引入之前。后续实现只按文件静态审阅和重写，没有恢复受污染分支中的旧控制框架。

```text
Manager route proposal
        |
        v
route schema/rule validation
        |
        v
ROUTE_PLAN_CONFIRMATION ----------> human capability
        |
        v
frozen route_hash / steps / approvals
        |
        v
prepare -> dispatch -> reconcile -> local Gate
                       |               |
                       |               +-> post-step human approval
                       +-> JSON repair / task retry / error escalation
        |
        v
latest LangGraph checkpoint
```

## 唯一事实源

SQLite checkpointer 保存 LangGraph checkpoint、pending writes 和 metadata。checkpoint 内状态包括：

- workflow phase、condition、outcome 和 revision；
- 冻结路线、审批计划和当前 step；
- task/run/session/attempt、manifest 和 Gate；
- base commit、candidate commit 和 candidate history；
- pending human approval；
- SHA-256 事件链和紧凑错误报告。

Agent 输出、launcher 状态、monitor telemetry、Git 分支名和 Markdown 报告都不是状态权威。所有状态变化必须经过 graph node，并由 runtime/human capability 调用。

## 路线与派发

Manager 只生成 `route-plan.json`，不得填写 Agent ID。`config/stategraph-policy.json` 固定 task kind 到 Agent 的映射，并校验：

- 生命周期顺序和每个省略阶段的理由；
- TEST_ONLY、FEATURE 等 request class 门槛；
- 架构、安全、迁移、多组件等风险门槛；
- DEVELOPMENT 后必须有 TEST；
- 高风险路线必须包含阶段后人工审批。

每轮始终先生成路线确认节点。批准后，`route_hash`、steps 和 approval plan 冻结；dispatch 是唯一 Agent 调用入口。

## Git 候选边界

每次 Agent attempt 使用独立 detached worktree：

```text
runtime/worktrees/<workflow>/<task>/<run>/repo
```

DEVELOPMENT/TEST 的 `output_commit` 必须是完整 commit SHA、基于 `input_commit`、并等于 worktree HEAD。通过 Gate 后才推进 candidate；若该 step 需要人工审批，则批准后才推进。REVIEW 和 RELEASE 只能读取 checkpoint 当前 candidate，不能替换它。

## 上下文与结果边界

每个 run 由代码生成 `context-manifest.json`，记录身份、input commit、授权路径、规则副本和 SHA-256。dispatch 前与 reconcile 前都会验证普通文件、非 symlink、路径归属和字节级 SHA。

Agent 只写：

- 本 run 的 `.agent-raw`；
- 授权 worktree；
- runner 指定的 raw logs。

本地 ingestion 负责确定性 JSON 清洗、Ajv 校验、身份比对、report/CommandRecord/evidence 路径与 SHA 校验，以及原子发布。标准文件摘要直接对原始字节计算。

## 重试与恢复

- JSON 重新生成：同 session 最多 2 次，不创建新 task attempt。
- Agent attempt：初次加 2 次自动重试，共 3 次，每次新 run/session/worktree。
- 三次失败：生成 `ERROR_ESCALATION`，只能由人工选择同一 Agent 新批次重试或终止。
- workflow 重启：从最新 checkpoint 恢复，不依赖聊天历史或进程内存。

## TEST Docker sandbox

TEST 固定使用 Docker：network none、只读 rootfs、drop ALL、PID 256、2GiB、2 CPU、非 root。每次 session 动态挂载 `/worktree`、`/input`、`/agent-raw`、`/raw-logs`。

动态 bind 配置由全局 lease 串行化。lease 在写配置前持久化；attestation 失败、runner 异常或陈旧 lease 接管时，代码先验证当前 binds，再恢复原配置、重建 session 并释放锁。配置出现第三种未知值时失败关闭。

## Monitor

`monitor/main.mjs` 启动 Node.js 后端。它只调用 runtime 的 `list()` / `audit()` 读取 checkpoints，并把会话、artifact 和健康信息放入独立 telemetry 数据库。monitor 无审批、重试或状态写入 API。

## 项目内实现

未引入第二个编排框架。项目内自研部分包括 SQLite checkpointer、事件哈希链、双 capability、workflow lock、固定 dispatch、路线编译器、worktree 管理、context manifest、证据接收边界、sandbox attestation/lease、紧凑 Manager context 和 checkpoint monitor read model。

`scripts/runtime-core/`（`atomic-store.mjs`、`json-ingestion.mjs`、`structured-output-ingestion.mjs`、`workflow-lock.mjs`）仍被 ingestion 相关逻辑复用；`scripts/control-core/`、`scripts/orchestrator/` 是旧三层架构遗留的空/半空目录，已随 2026-08-14 重建清空内容，仅作历史占位，不承载任何当前逻辑，后续清理时可直接删除。

## 复用与重做边界

| 范围 | 处理 | 原因 |
| --- | --- | --- |
| 七个 Agent 角色与 workspace 目录 | 复用角色，重写永久规则 | 分工仍有效，但旧规则包含多控制面、Manager 派发和无沙箱假设 |
| JSON 清洗、Ajv 校验与原子文件发布 | 复用经过测试的无状态工具 | 这些工具不拥有 workflow 状态，可继续作为本地 ingestion 基础 |
| monitor 的 telemetry、脱敏、SSE 和会话解析 | 复用只读能力 | 展示能力与状态权威正交，改为读取 checkpoint 即可保留 |
| workflow 状态、路由、审批与恢复 | 以 StateGraph/checkpointer 重做 | 必须消除多套状态库、命令面和恢复来源 |
| Agent 派发与结果接收 | 以固定 dispatch/reconcile 重做 | 防止 Manager、worker 或 launcher 绕过代码映射和 Gate |
| TEST 执行边界 | 以 Docker policy、attestation 和 lease 重做 | 旧本机执行无法证明隔离、mount 和异常恢复 |
| monitor 服务入口 | 以 Node.js `monitor/main.mjs` 重做 | 与项目技术栈一致，并删除 Java/Tomcat 代理和第二部署链 |
| 安装、模型限制和 artifact 权限 | 重写并跨平台验证 | 策略声明必须同步到实际 provider/model 与主机 ACL 才能成立 |

## 成本边界

Manager context window 为 `200000`，max output 为 `32000`。软输入预算按 `config/stategraph-policy.json` 的 `manager.soft_budget_percent`（当前 `60`）动态计算，即 `context_window_tokens × soft_budget_percent / 100`，当前等于 `120000`，并非硬编码常量。实际单次紧凑 prompt 硬上限为 `12000` 字符。默认只携带最近 8 个事件和 4 个错误摘要；超限后进一步压缩。Manager 不轮询 worker。
