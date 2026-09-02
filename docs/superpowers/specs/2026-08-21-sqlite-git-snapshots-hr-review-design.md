# SQLite Control Kernel、Git 快照与 HR 审查设计

## 1. 目标

本次重构把 PostgreSQL Control Kernel 替换为单机 SQLite，从空库开始，不迁移历史数据。SQLite 只承担工作流事实、执行租约、通知、HR 任务和 Git 快照索引；代码版本与回滚继续由 Git 保存，不在数据库中重复存储文件内容。

同时删除没有实际运行时消费者的 revision CAS、事件哈希链和事件链审计。HR Agent 改为手动优先的审查器：按 Agent Session 读取经过脱敏和裁剪的 thinking/reasoning、最后一条助手输出，以及宿主计算的 Git 修改。自动审查接口保留，但默认关闭。

## 2. 部署边界

- 仅支持一台服务器上的一个 Orchestrator 写进程。
- Monitor 以只读连接读取同一个 SQLite 文件。
- 不允许把 SQLite 文件放在 SMB、NFS、云盘同步目录或由多台机器共享。
- 默认事实库路径为 `runtime/control/kernel.db`。
- Monitor telemetry 继续使用独立的 `runtime/monitor/monitor.db`。
- Node.js 最低版本为 22.13，使用内置 `node:sqlite`，不增加原生数据库依赖。

数据库启动时设置：

- `PRAGMA journal_mode=WAL`；
- `PRAGMA foreign_keys=ON`；
- `PRAGMA busy_timeout=5000`；
- `PRAGMA synchronous=FULL`；
- 写进程启动锁，阻止第二个 Orchestrator 同时运行。

## 3. 数据模型

权威 SQLite 包含八张表：

1. `runs`
2. `tasks`
3. `executions`
4. `artifacts`
5. `approvals`
6. `notifications`
7. `hr_jobs`
8. `snapshots`

所有时间使用 UTC RFC 3339 TEXT；对象和数组使用 JSON TEXT，并在写入前序列化、读取后解析。主键均由应用生成。外键和状态 CHECK 继续保留。`executions` 使用部分唯一索引保证一个 task 至多一个 `LEASED`/`RUNNING` execution。

以下 PostgreSQL 专属内容删除：schema、`search_path`、`JSONB`、`TIMESTAMPTZ`、`BIGSERIAL`、数组类型、`ANY()`、`RETURNING` 依赖、连接池参数和 Docker PostgreSQL。

## 4. 删除的追踪机制

删除：

- `runs.revision`、`expectedRevision`、`RUN_CAS_CONFLICT`；
- `events` 表及 `event_id`、`prev_hash`、`event_hash`；
- `appendEvent()`、`auditEvents()`、事件幂等键和事件链测试；
- Monitor 的通用 Kernel event 投影与事件链健康状态；
- HR 的 `source_event_id`；
- `runtime/artifacts/cas` 的重复内容寻址副本。

工作流状态变化直接写相应事实表。需要通知 Manager 的动作直接写 `notifications` outbox，不通过事件表中转。HR 告警和审查依据保存在 `hr_jobs.input`，Monitor 从 `hr_jobs` 读取。

Artifact 文件仍保存 SHA-256、路径、执行与 commit 关联，用于完整性验证，但不再额外复制到内容寻址目录。

## 5. Git 快照

### 5.1 职责边界

- Git object database 保存文件版本、提交血缘和差异。
- SQLite `snapshots` 只保存 workflow/task/execution/Agent/Session 到 Git commit 的索引。
- OpenClaw Session 保存对话身份与历史，不作为文件修改事实源。

### 5.2 快照字段

`snapshots` 至少包含：

- `snapshot_id`
- `run_id`、`task_id`、`execution_id`
- `attempt`、`agent_id`、`session_id`
- `input_commit`、`output_commit`
- `parent_snapshot_id`
- `git_ref`
- `snapshot_kind`：`ACCEPTED`、`FAILED_RECOVERY`、`NO_CHANGE`、`RESTORE`、`REVERT`
- `change_summary`：宿主计算的新增、修改、删除、重命名及统计
- `worktree_path_abs`
- `created_at`

每个 output commit 建立 `refs/openclaw/snapshots/<snapshot-id>` 隐藏引用，防止 detached worktree 清理后 commit 被 Git 回收。

### 5.3 完成校验

Agent 成功返回后，宿主必须验证：

1. `output_commit` 为完整 SHA 且真实存在；
2. `output_commit` 等于 worktree HEAD；
3. `output_commit` 是 `input_commit` 的后代；
4. 成功结果下 worktree 无未提交修改；
5. 宿主通过 Git 计算真实的 name-status、stat 和文件列表，不能信任 Agent 自报；
6. 修改范围符合任务授权。

非代码 Agent 记录 `NO_CHANGE` 快照，input 与 output 相同。若 Agent 崩溃、超时或留下脏工作区，宿主创建本地 recovery commit 和 `FAILED_RECOVERY` 快照，但不推进 `candidate_commit`。

### 5.4 恢复语义

- `snapshot list/show/diff` 为只读操作。
- `snapshot restore` 从目标 commit 创建新的恢复分支和 worktree，不改当前历史。
- `snapshot revert` 在明确确认后创建 `git revert` commit，不使用 `reset --hard`，冲突时停止并要求人工处理。
- 快照恢复和撤销也写入 `snapshots`，形成可见的 Git 版本时间线，但不引入事件哈希链。

## 6. HR Session 审查

### 6.1 审查目标

首版只检查三类问题：

1. 越权：修改、工具使用或结论超出任务与角色边界；
2. 边界不清晰：没有说明假设、限制、未完成项或职责交界；
3. 猜测与模糊结果：thinking 或最终输出以猜测代替验证，或使用不能落到证据的模糊表述。

HR 只输出发现、证据定位、严重度和建议，不修改 workflow、不批准任务、不联系用户、不调用其他 Agent。

### 6.2 输入裁剪

“完整读入”指覆盖选定 workflow/task/day 范围内的每个相关 Agent Session，而不是把完整聊天全文传给 HR。每个 Session 独立生成一份审查 dossier，仅包含：

- assistant thinking/reasoning 块，按原顺序保留并脱敏；
- 最后一条 assistant 可见文本；
- Session 的 Agent、task、execution、时间和输入/output commit 元数据；
- 对应 snapshot 的真实 name-status、diff stat 和文本 patch；
- 二进制文件只提供文件名、状态和大小变化，不内联内容；
- 截断发生时提供明确的 `truncated`、原始字符数和保留字符数。

不输入用户消息全文、system prompt、工具参数、工具输出、凭据或中间可见回复。单个 Session 单独调用 HR；日级或任务级汇总只组合各 Session 的 HR 发现，不重复输入原始历史。

### 6.3 手动与自动接口

HR Agent 本身保持启用，但自动调度默认关闭：

```text
OPENCLAW_HR_ENABLED=true
OPENCLAW_HR_AUTO_MODE=off
```

`OPENCLAW_HR_AUTO_MODE` 支持：

- `off`：只允许手动；默认值；
- `task`：任务终态后为该任务各 Session 排队；
- `daily`：显式日调度入口按日期排队；
- `both`：同时启用 task 和 daily 接口。

提供 CLI：

- `hr-review --workflow-id <id>`
- `hr-review --task-id <id>`
- `hr-review --date <YYYY-MM-DD>`
- `hr-run-pending`

入队使用稳定的 `review_key` 去重，重复扫描不会重复审查同一 snapshot/session。自动 daily 只提供可由 cron/systemd timer/Task Scheduler 调用的命令入口，本次不创建系统级定时任务。

## 7. Monitor

Monitor 继续只读：

- 展示 SQLite workflow/task/execution/approval/notification/HR 状态；
- 增加 snapshot 列表、Agent、Session、commit 和修改摘要；
- 提供只读 diff 查询；
- 不在 Monitor 进程中自动调用 HR；
- 不直接执行 restore/revert，界面只显示对应 CLI 指引；
- 删除 PostgreSQL 降级文案和 Kernel events 数据源。

Monitor telemetry 数据库仍可删除重建，不参与事实恢复。

## 8. 安全与错误处理

- SQLite 文件和 WAL/SHM 位于同一台机器的本地磁盘。
- 数据库写操作使用短事务；锁等待超过 busy timeout 后明确失败，不静默丢写。
- 快照 commit、血缘、HEAD 或 clean 校验失败时任务失败并保留 recovery snapshot。
- Session 文件只允许从配置的 OpenClaw Agent session 根目录读取，并验证 Agent/Session ID 和常规文件边界。
- 所有交给 HR 的文本先脱敏；HR prompt 明确禁止把 thinking 原文复制到最终报告，只允许给出最短证据片段和定位。
- Restore 默认创建新 worktree；Revert 要求显式确认；不提供破坏性历史重写。

## 9. 测试

至少覆盖：

- 空 SQLite 初始化、重复初始化、外键、CHECK 和 WAL 配置；
- repository CRUD、通知、审批、HR job 和 lease 原子互斥；
- 两连接读写、busy timeout 与重启恢复；
- output commit 存在、血缘、HEAD、dirty worktree 和 recovery snapshot；
- snapshot ref 防回收、真实 diff、restore 和 revert 冲突停止；
- Session thinking/最终输出裁剪、脱敏、路径逃逸和字符上限；
- HR 三类规则、review key 去重、手动模式和四种自动配置；
- Monitor SQLite read model、snapshot/HR 展示和无后台 HR 调用；
- Windows/Linux install dry-run、validate 与 Agent package 同步；
- 全量 `npm test`。

## 10. 文档和安装同步

更新 README、架构、监控、Git worktree、Agent contract、HR、部署、环境变量、CHANGELOG、ADR 和历史文档状态说明。删除不存在或不再适用的 PostgreSQL、schema、Docker PG、事件链和 StateGraph 描述。

本次会修改 `agents/common/`、`agents/hr-agent/workspace/`、Developer/Test Git 规则和 HR package，因此实施完成后必须更新已安装 Agent。普通更新不要求停止 Gateway；只有普通更新失败或受管理 runtime 损坏时才使用安全重装。

