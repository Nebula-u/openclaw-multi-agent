# Todo App 代码审查任务

你是 review-agent。请对 developer-agent 产出的 Todo App 源码进行全面代码审查。

## 关键信息

- dispatch_id: DSP-dd98b6f3-ecce-4326-9dad-df97907f3d71
- workflow_id: WF-todo-app
- task_id: TASK-todo-review
- run_id: RUN-REV-001
- assigned_agent: review-agent
- attempt: 1
- context_manifest_path_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\artifacts\WF-todo-app\TASK-todo-review\RUN-REV-001\context-manifest.json
- worktree_path_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\WF-todo-app\TASK-todo-review\RUN-REV-001\repo
- artifact_root_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\artifacts\WF-todo-app\TASK-todo-review\RUN-REV-001

## 输入文件

请先读取 context-manifest.json，验证哈希。然后读取需求文档和架构文档。源码（需审查的代码）位于：
D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\WF-todo-app\TASK-todo-dev\RUN-DEV-001\repo\src\
逐一读取审查所有 .tsx 和 .ts 文件（共约 35 个文件）。

## 审查重点

1. **架构合规性**: 是否符合架构设计文档的技术栈和组件结构
2. **代码质量**: TypeScript 类型安全、React 最佳实践、组件复用
3. **功能完整性**: 是否覆盖所有 16 条功能 AC
4. **安全性**: XSS 防护（localStorage 数据）、输入校验
5. **性能**: 不必要的重渲染、useMemo/useCallback 使用
6. **可维护性**: 命名规范、注释、代码组织

## 输出要求

审查完成后，将结果写入 artifact_root_abs/.agent-raw/ :
- .agent-raw/result.json.raw — result_status: "PASS" | "NEEDS_REWORK" | "COMMENTS_ONLY"
- .agent-raw/evidence.jsonl.raw — 每条发现的证据
- .agent-raw/command-records.jsonl.raw — 命令记录

不要调用 sessions_spawn、sessions_send 或其他 Agent 派发工具。
