# CONTEXT_PROTOCOL.md — 上下文与规则传递协议

> 版本: context-protocol v1
> manager-agent 是本协议的执行者；工作 Agent 是消费者。

## 1. 任务上下文包结构

manager-agent 在每次派发前，于 `<artifact_root_abs>/input/` 创建完整上下文包：

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

`schema_version`、`workflow_id`、`task_id`、`run_id`、`assigned_agent`、`created_at`、`manager_session_reference`、`target_project_root_abs`、`worktree_path_abs`、`artifact_root_abs`、`input_files`（含各文件 SHA-256）、`rule_version`、`rule_hash`、`input_commit`、`expected_output_paths_abs`。

## 5. 上下文传递规则（硬性）

1. **不**向工作 Agent 复制完整用户聊天历史。
2. **不**要求工作 Agent 读取 manager 的私有会话历史。
3. 派发消息只提供：任务摘要 + 绝对 `context-manifest.json` 路径 + 绝对 `task.json` 路径 + 绝对输出目录 + 绝对 worktree 路径。
4. 工作 Agent **先读取并校验**上下文包，再开始工作。
5. 上下文不足 → 只返回缺失项，不自行扩大范围。
6. manager 更新规则后，**不篡改**已派发任务的 input；必须创建新 attempt + 新 run_id + 新规则快照。
7. manager 每阶段结束更新 `context-summary.md`，只保留后续阶段真正需要的事实/决策/限制/证据引用。
8. 最小充分原则：只传递完成当前任务所必需的上下文。

## 6. 工作 Agent 侧消费步骤

1. 用派发消息给的绝对路径读取 `context-manifest.json`。
2. 逐一校验（见 COMMON_RULES 第 2 节）。
3. 读取 `context.md` / `rules.md` / `task.json` / `acceptance-criteria.json` / `approved-decisions.json` / `source-manifest.json`。
4. 若发现哈希不一致、路径非法或 `assigned_agent` 不匹配 → `BLOCKED`。
5. 开始工作，只在允许范围内读写。
