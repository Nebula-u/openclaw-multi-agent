# CONTEXT_PROTOCOL.md — 上下文与规则传递协议

> 版本: context-protocol v2
> StateGraph dispatch 是本协议的执行者；工作 Agent 是只读消费者。

## 1. 任务上下文包结构

StateGraph 在每次派发前，于 `<artifact_root_abs>/input/` 创建不可变上下文包：

```
<ABS_ARTIFACT_RUN_ROOT>/input/
├── task.json                 # 任务定义（见 contracts/task.schema.json）
├── context.md                # 人类可读上下文（见下）
├── rules.md                  # 角色规则 + 任务规则（见下）
├── acceptance-criteria.json  # 相关验收标准
├── approved-decisions.json   # 已批准的人工决策
├── source-manifest.json      # 相关源文件清单（路径+哈希，只读引用）
└── context-manifest.json     # 机器可读清单（见 contracts/context-manifest.schema.json）
```

## 2. `context.md` 必含内容

- workflow 摘要 / 当前阶段 / 当前任务目标
- 明确范围与非范围
- 已批准的需求摘要
- 与本任务相关的架构摘要
- 当前候选 commit
- 前序 Agent 结论摘要
- 已知风险与未解决问题
- 要求产生的输出
- 允许修改的绝对路径 / 禁止修改的路径
- 需要执行的验证

所有上下文摘要必须区分 `OBSERVED` / `INFERRED` / `PROPOSED` / `UNKNOWN`。

## 3. `rules.md` 必含内容

- 通用规则版本与哈希（common-rules）
- 角色规则版本与哈希
- workflow policy 摘要
- 本任务额外约束
- 网络、依赖安装、凭证、破坏性操作、测试隔离规则

## 4. `context-manifest.json` 必含字段

`schema_version`、`workflow_id`、`task_id`、`run_id`、`assigned_agent`、`attempt`、`created_at`、`target_project_root_abs`、`worktree_path_abs`、`artifact_root_abs`、`input_files`（含各文件 SHA-256）、`rule_version`、`rule_hash`、`input_commit`、`expected_output_paths_abs`。

## 5. 上下文传递规则（硬性）

1. **不**向工作 Agent 复制完整用户聊天历史。
2. **不**要求工作 Agent 读取 manager 的私有会话历史。
3. 派发消息只提供：任务摘要、`dispatch_id`、input manifest SHA-256、绝对 `context-manifest.json` 路径、绝对 `task.json` 路径、绝对输出目录 + 绝对 worktree 路径。
4. 工作 Agent **先读取并校验**上下文包，再开始工作。
5. 上下文不足 → 只返回缺失项，不自行扩大范围。
6. 规则更新后，**不篡改**已派发任务的 input；StateGraph 必须创建新 attempt + 新 run_id + 新规则快照。
7. checkpoint 只保存后续阶段真正需要的事实、决策、限制与证据引用；原始日志留在本 run artifact。
8. 最小充分原则：只传递完成当前任务所必需的上下文。
9. Monitor endpoint 只通过运行环境提供；上下文包可以声明“activity enabled”，但不得包含
   `MONITOR_TOKEN` 或其他凭据。

## 7. Dispatch 启动与完成确认

1. 工作 Agent 启动后，先比对派发消息中的 `dispatch_id`、workflow/task/run/agent ID 与 `context-manifest.json`，并计算/核对 input manifest SHA-256；不一致即 `BLOCKED`，不写产物、不开始工作。
2. 校验完成后开始当前任务；启动状态由 runner 的真实进程事实记录，Agent 不发送会改变状态的 ACK。
3. 先完整落盘所有结构化原文、报告、日志、校验和与（适用时）Git commit；进程退出后由 reconcile 校验结果，Agent 自述不代表完成事实。
4. 若 runner 终止当前 run，立即停止新增写入并如实退出；不得调度其他 Agent或自行重试。

## 6. 工作 Agent 侧消费步骤

1. 用派发消息给的绝对路径读取 `context-manifest.json`。
2. 逐一校验（见 COMMON_RULES 第 2 节）。
3. 读取 `context.md` / `rules.md` / `task.json` / `acceptance-criteria.json` / `approved-decisions.json` / `source-manifest.json`。
4. 若发现哈希不一致、路径非法或 `assigned_agent` 不匹配 → `BLOCKED`。
5. 开始工作，只在允许范围内读写。
