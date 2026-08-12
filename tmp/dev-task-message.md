# Todo App 开发任务

你是 developer-agent。请基于需求和架构设计，用 React + TypeScript + Vite + Tailwind CSS + Zustand + Framer Motion 在 worktree 内实现完整的单页面 Todolist 应用。

## 关键信息

- dispatch_id: DSP-4ca6ec25-046a-4d5c-ba98-4d4f4337f998
- workflow_id: WF-todo-app
- task_id: TASK-todo-dev
- run_id: RUN-DEV-001
- assigned_agent: developer-agent
- attempt: 1
- context_manifest_path_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\artifacts\WF-todo-app\TASK-todo-dev\RUN-DEV-001\context-manifest.json
- worktree_path_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\WF-todo-app\TASK-todo-dev\RUN-DEV-001\repo
- artifact_root_abs: D:\MicroConnect\project\openclaw-multi-agent\runtime\artifacts\WF-todo-app\TASK-todo-dev\RUN-DEV-001

## 输入文件

请先读取 context-manifest.json，验证所有 input_files 的 SHA-256 哈希，然后读取需求分析和架构设计文档。

## 开发要求

在 worktree_path_abs (D:\MicroConnect\project\openclaw-multi-agent\runtime\worktrees\WF-todo-app\TASK-todo-dev\RUN-DEV-001\repo) 中创建完整的 React + TypeScript + Vite 项目。

### 技术栈（按架构设计）
- React 18 + TypeScript 5
- Vite 5 构建
- Tailwind CSS 3 样式
- Zustand 状态管理（含 localStorage 持久化中间件）
- Framer Motion 动画

### 功能要求
按照需求规格文档中的 20 条 AC 实现：
1. 任务增删改查、完成状态切换
2. 优先级（高/中/低）设置和颜色指示
3. 标签/分类系统
4. 按优先级和标签筛选排序
5. 暗色/亮色模式切换
6. 响应式布局
7. 数据持久化到 localStorage

### 设计要求
- 精美现代 UI 设计，参考 frontend-design skill
- 平滑动画过渡
- 空状态友好提示
- 响应式支持桌面和移动端

### 输出要求
开发完成后，将以下 final output 写入 artifact_root_abs/.agent-raw/ :
- .agent-raw/result.json.raw — 包含 result_status: "COMPLETED", self_validation, summary 等信息
- .agent-raw/evidence.jsonl.raw — 包含文件哈希、构建验证等证据
- .agent-raw/command-records.jsonl.raw — 包含执行的命令记录

**重要：绝对不要调用 sessions_spawn、sessions_send 或其他 Agent 派发工具。只做开发工作。**
