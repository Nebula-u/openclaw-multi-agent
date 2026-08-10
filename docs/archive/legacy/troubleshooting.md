# troubleshooting.md — 常见问题与处理

> 版本: troubleshooting v1
> 本文件给出常见问题的**安全处理路径**。所有处理都遵守 `agents/common/SECURITY_RULES.md`：不改用户环境、不联网、不安装、不执行破坏性命令、不执行 `openclaw doctor --fix`。
> 散文用中文；命令、状态值、字段用英文。全部路径用**绝对路径**。

## 通用前提

- 所有命令都用**绝对路径**执行，不依赖当前工作目录。即使从 `C:\Windows\System32` 启动也必须能正确解析。
- 破坏性 / 不可逆 / 影响其他项目的操作一律先走人工审批（见 `docs/human-approval.md`）。
- 遇到工具缺失 / 环境阻塞 → 记 `BLOCKED` 或 `UNKNOWN`，**不假装成功**。

---

## 1. 从 `C:\Windows\System32`（或任意非项目目录）运行安装 / 脚本

**现象**：在 `System32` 或其他非项目 cwd 下启动，担心相对路径解析错误。

**原因**：脚本或 Agent 若依赖当前工作目录，会解析到错误位置。

**处理**：
- 本系统设计为**不依赖当前工作目录**。安装与运行时定位一律使用 `install-manifest.json` 中的绝对 `runtime_root_abs`，以及 project-config 中的绝对 `target_project.root_abs`。
- 调用脚本时传入**绝对路径**参数；Git 命令用 `git -C "<abs>"`。
- 校验：确认解析出的路径为绝对路径且存在；若脚本内部出现相对运行时路径（如 `./repo`、`../worktree`）视为缺陷，需修正为绝对路径。
- 不因 cwd 不同而改变任何行为；不写全局环境变量去“修复” cwd。

---

## 2. Agent 已存在冲突（agent already exists）

**现象**：`openclaw agents add` 提示目标 Agent / workspace 已存在。

**原因**：同名 Agent 或同一 workspace 已被创建；可能是用户既有 Agent。

**处理**：
- **不得覆盖 / 删除用户已有 Agent、配置、workspace、binding、会话**（`SECURITY_RULES.md` 第 1 节）。
- 先用 `openclaw agents list`（只读）确认现有 Agent 及其 `workspace` / `agentDir`。
- 若冲突的是用户既有的、与本项目无关的 Agent → 使用本项目**专用的、隔离的**绝对 `--workspace` 与 `--agent-dir`，避免重名；必要时向用户澄清命名。
- 若确需改动既有 Agent → 属影响用户环境的操作，先走人工审批（`DESTRUCTIVE_OR_CROSS_PROJECT`）。
- 记录：把 `agents add` 是否实际执行、参数、退出码作为 CommandRecord 保存；未执行则标 `NOT_EXECUTED`。

---

## 3. `openclaw config validate` 失败，如何回滚备份

**现象**：改动配置后 `openclaw config validate --json` 退出码非 0（本项目基线为 0，见 `docs/compatibility-report.md`）。

**原因**：写入的配置不合法或与 schema 冲突。

**处理**：
- **写入前优先用 `--dry-run` 预校验**：`openclaw config set <path> <value> --strict-json --dry-run`（"Validate changes without writing"）。校验通过再真正写入。
- 若已写入且 validate 失败：从 manager-agent 维护的配置快照目录 `<RUNTIME_ROOT_ABS>/control/config-snapshots/` 找到改动前的快照，按原路径**恢复到改动前状态**（用原生文件复制，不用 Python 脚本）。
- 恢复后再次运行 `openclaw config validate --json` 确认恢复为 0。
- 全过程保存 CommandRecord（含真实 `exit_code` 与日志），失败日志**不删除**（见 `docs/evidence-and-claims.md` 第 7 节）。
- 不使用破坏性手段“强行修复”；不改动与本次变更无关的配置。

---

## 4. `openclaw doctor --lint` 退出 1 的处理（不 `--fix`）

**现象**：`openclaw doctor --lint --json` 退出码为 1。

**原因**：这是**用户环境既有提示**。本项目 preflight 已如实记录（`ok=false`，findings 含 `openclaw.json` 明文 secret 警告与 `policy.jsonc` 缺失警告）；证据见 `artifacts\preflight\openclaw-doctor-lint.*`。

**处理**：
- **不执行 `openclaw doctor --fix`**，不修复、不改动用户配置（`SECURITY_RULES.md` 第 1 节）。
- 把 lint 结果作为**已知环境状态**如实记录，不作为本项目失败；不因它阻断与之无关的工作。
- 如涉及明文凭证提示：**只上报路径名与类别**（如 `gateway.auth.token`），**不复制凭证明文**到任何 artifact。
- 是否处理这些提示属**用户自己的决定**；如用户要求处理，须作为独立、显式、经审批的操作，且不由本工作流自动进行。

---

## 5. worktree 残留（leftover worktree）

**现象**：`<RUNTIME_ROOT_ABS>/worktrees/...` 下存在上次运行遗留的 worktree。

**原因**：任务失败 / 脏状态 / 未合并 / 待审批时，worktree **默认被保留**（`GIT_RULES.md` 第 6.4 条），这是有意的安全行为，便于复核与恢复。

**处理**：
- **默认不清理**失败 / 脏 / 未合并 / 待审批的 worktree。
- 需要复核时，用只读命令查看：`git -C "<worktree_abs>" status --porcelain`、`git -C "<worktree_abs>" log --oneline -n 5`。
- 确需移除时，属可能丢失未合并工作的操作 → **先人工审批**；获批后用非破坏性方式（如 `git worktree remove`）处理，**禁止** `git clean -fdx` / 递归强删 / `git reset --hard`。
- 新的重做使用**新的 `run_id` 与新目录**，不覆盖旧 worktree / 旧日志。

---

## 6. 非 Git 目录 / 未提交修改（需审批）

**现象**：目标项目不是 Git 仓库，或存在未提交修改。

**原因**：命中 Git 前置审批节点。

**处理**：
- 目标不是 Git 仓库 → **不擅自 `git init`**，生成 approval-request（`trigger = INPUT_NOT_GIT_REPO`），置 `WAITING_HUMAN`。
- 存在未提交修改 → **不**自动 commit / stash / 丢弃 / reset / 覆盖，生成 approval-request（`trigger = INPUT_DIRTY_WORKTREE`），由用户选择处理方式。
- 探测用只读命令：`git -C "<target_abs>" status --porcelain=v2 --branch`、`git -C "<target_abs>" rev-parse HEAD`。
- 等待期间不调度依赖该决策的任务；**无自动超时同意**。

---

## 7. 测试命令找不到工具（BLOCKED / UNKNOWN）

**现象**：执行测试 / 构建时，所需工具不存在（command not found / 非零退出）。

**原因**：环境未安装该工具；本系统**默认禁止自动安装**。

**处理**：
- **不自动安装依赖、不联网获取工具**（`command_boundaries.allow_dependency_install = false`）。
- 测试命令只能来自：用户配置 / 项目自身 build 配置 / 已批准测试策略（见 `docs/unsandboxed-test-policy.md` 第 5 节）；**不得凭语言猜一个通用命令**。
- 工具确实缺失 → 该检查记 `BLOCKED` 或 `UNKNOWN`（`NOT_EXECUTED`），在 `result.json.unresolved_issues` 写明缺失项与证据，**不假装执行、不编造退出码 / 覆盖率**。
- 如需安装或联网才能继续 → 生成 approval-request（`trigger = NEEDS_INSTALL_OR_NETWORK`）。

---

## 8. 恢复中断的 workflow

**现象**：manager 会话或 Gateway 中断，聊天上下文丢失。

**原因**：会话中断；但**聊天记录不是唯一状态源**。

**处理**（按 `manager-agent/AGENTS.md` 第 9 节恢复算法）：
1. 读 `<RUNTIME_ROOT_ABS>/control/active-workflows.json`。
2. 恰好一个活动 workflow → 读其 `workflow.json`、`events.jsonl`、`context-summary.md`、未决 decisions 与 Git 状态后恢复。
3. 多个活动 workflow → **让用户选择**，不擅自挑选。
4. 校验一致性：`events.jsonl` 哈希链完整；`workflow.json` 快照与最新事件、与 Git（当前候选 commit / 分支 / worktree）一致。
5. 不一致 → 置 `HOLD`，保留证据，向用户报告差异，等待指示。
6. 绝不因聊天上下文丢失而丢失工作流；重做用新 `run_id`，不覆盖历史 run。

---

## 9. 相关文件

- 规则来源：`agents/common/SECURITY_RULES.md`、`agents/common/GIT_RULES.md`、`agents/common/EVIDENCE_RULES.md`、`agents/manager-agent/workspace/AGENTS.md`（第 9 节恢复）
- 兼容性基线：`docs/compatibility-report.md`
- 关联文档：`docs/human-approval.md`、`docs/unsandboxed-test-policy.md`、`docs/gate-checklists.md`
