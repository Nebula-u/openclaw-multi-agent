# 可读工作区目录布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 后续工作流任务将工作副本、输入、输出和日志创建在项目根目录的 `work/` 中，并使用可读目录名，不迁移既有 runtime 数据。

**架构：** 增加一个独立的任务工作区分配器，负责安全地将目标项目名和任务标题转为可读路径，并以递增短序号处理冲突。Orchestrator 在首次准备任务时持久化该目录的绝对路径；Git worktree、上下文、输出收集和 sandbox 均使用这个已分配路径。`runtime/` 保留控制数据库、Agent bundle 和控制队列。

**技术栈：** Node.js ESM、内置 `node:test`、PowerShell、Bash。

## 全局约束

- 只影响后续创建的任务；不得迁移、重命名、删除或回填已有 `runtime/` 数据。
- 工作区根为 `<本项目根>/work/`，所有分配路径 canonicalize 后必须仍位于该根内。
- 目录名由目标项目 basename 与任务标题生成；保留 Unicode 字母和数字，移除 Windows 非法字符，使用小写连字符，空值分别回退为 `project`、`untitled-task`。
- 命名冲突仅追加 `-2`、`-3` 等短序号；不得将 workflow、task、run、execution ID 用作目录名。
- `runtime/` 只保留控制数据库、Agent bundle 和控制命令队列；新的任务 worktree、输入、输出、日志与恢复 worktree 不得创建在该目录下。
- 每个任务完成其测试验证后立即单独 Git 提交；不推送远端。

---

### 任务 1：实现可读任务工作区分配器

**文件：**
- 创建：`scripts/orchestrator/task-workspace.mjs`
- 创建：`tests/orchestrator-task-workspace.test.mjs`

**接口：**
- 产生：`createTaskWorkspaceManager({ projectRoot })`，返回 `{ workspaceRoot, reserve(task), restorePathFor(snapshotId) }`。
- `reserve(task)` 接收 `{ targetProjectRootAbs, title }`，原子创建并返回 `{ workspaceRootAbs, worktreePathAbs }`；其中 `worktreePathAbs === join(workspaceRootAbs, 'repo')`。
- `restorePathFor(snapshotId)` 只在 `<projectRoot>/work/restores/` 下返回可安全创建的恢复目录。

- [ ] **步骤 1：写出失败测试**

```js
test('workspace names are readable and collisions receive short suffixes', () => {
  const manager = createTaskWorkspaceManager({ projectRoot: root });
  const first = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', title: '新增 登录功能！' });
  const second = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', title: '新增 登录功能！' });
  assert.equal(basename(first.workspaceRootAbs), 'storefront-新增-登录功能');
  assert.equal(basename(second.workspaceRootAbs), 'storefront-新增-登录功能-2');
  assert.equal(first.worktreePathAbs, join(first.workspaceRootAbs, 'repo'));
});
```

同时覆盖空名称回退、Windows 非法字符清理、72 字符上限、`work/` 边界，以及 `restores/` 位于 `work/` 而非 `runtime/`。

- [ ] **步骤 2：运行测试，确认失败**

运行：`node --test tests/orchestrator-task-workspace.test.mjs`

预期：失败，提示无法导入 `task-workspace.mjs`。

- [ ] **步骤 3：实现最小分配器**

```js
export function createTaskWorkspaceManager({ projectRoot }) {
  const workspaceRoot = join(resolve(projectRoot), 'work');
  function reserve(task) {
    const base = `${slug(basename(resolve(task.targetProjectRootAbs))) || 'project'}-${slug(task.title) || 'untitled-task'}`;
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? base : `${base}-${suffix}`;
      const candidate = join(workspaceRoot, name);
      try { mkdirSync(candidate, { recursive: false }); return { workspaceRootAbs: realpathSync.native(candidate), worktreePathAbs: join(realpathSync.native(candidate), 'repo') }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  return { workspaceRoot, reserve, restorePathFor };
}
```

`slug` 必须保留 Unicode 字母与数字，移除 `<>:"/\\|?*`、控制字符和路径分隔符，并将其他分隔符压缩为一个连字符；`reserve` 和 `restorePathFor` 必须使用 `relative`、`isAbsolute`、`resolve` 与 `realpathSync.native` 拒绝越界。

- [ ] **步骤 4：运行测试，确认通过**

运行：`node --test tests/orchestrator-task-workspace.test.mjs`

预期：全部通过。

- [ ] **步骤 5：提交**

```text
git add scripts/orchestrator/task-workspace.mjs tests/orchestrator-task-workspace.test.mjs
git commit -m "feat(orchestrator): allocate readable task workspaces"
```

### 任务 2：让 Orchestrator 和 Git worktree 使用已分配工作区

**文件：**
- 修改：`scripts/orchestrator/service.mjs`
- 修改：`scripts/orchestrator/git-worktree.mjs`
- 修改：`tests/orchestrator-snapshots.test.mjs`
- 修改：`tests/orchestrator-context-manifest.test.mjs`
- 修改：`tests/orchestrator-test-sandbox-staging.test.mjs`

**接口：**
- 消费：任务 1 的 `createTaskWorkspaceManager` 与 `reserve(task)`。
- `createGitWorktreeManager({ projectRoot })` 的 `prepare(task)` 接收已分配的 `workspaceRootAbs`，并只在 `<projectRoot>/work/` 内创建 `repo/`。
- `taskForStep` 将 `workspace_root_abs`、`worktree_path_abs` 与 `artifact_root_abs` 保存进 task payload，以便同一尝试再次调度时复用相同目录；重试因 attempt 改变而重新分配目录。

- [ ] **步骤 1：写出失败流程测试**

在快照测试中断言新准备的 worktree 形如 `work/<可读名称>/repo`，不包含 `runtime/worktrees`，并把临时仓库 `.gitignore` 改为 `work/`。在上下文测试中使用 `work/<name>` 作为 `artifactRootAbs`，断言 `input/`、`output/` 和 `logs/` 仍按既有固定文件名生成。为服务层新增或扩展测试，断言数据库 payload 中保存的三条绝对路径可被重复调度复用。

- [ ] **步骤 2：运行目标测试，确认失败**

运行：`node --test tests/orchestrator-snapshots.test.mjs tests/orchestrator-context-manifest.test.mjs tests/orchestrator-test-sandbox-staging.test.mjs`

预期：至少一条新路径断言失败，因为现有实现仍写入 `runtime/worktrees` 或 `runtime/artifacts`。

- [ ] **步骤 3：接入分配器与持久化路径**

```js
const taskWorkspaces = createTaskWorkspaceManager({ projectRoot });
const allocation = stored.payload?.workspace_root_abs
  ? { workspaceRootAbs: stored.payload.workspace_root_abs, worktreePathAbs: stored.payload.worktree_path_abs }
  : taskWorkspaces.reserve({ targetProjectRootAbs: run.targetProjectRootAbs, title: stored.title });
const prepared = selectedWorktrees.prepare({ ..., workspaceRootAbs: allocation.workspaceRootAbs });
const artifactRootAbs = allocation.workspaceRootAbs;
```

在首次分配时更新 task payload；当 payload 已含路径时，验证它们在 `work/` 内后复用。将 `git-worktree.mjs` 的 task worktree 根从 `runtime/worktrees` 改为注入的任务 `workspaceRootAbs`，并将 snapshot restore 根改为 `work/restores`。保留旧数据库路径的读取逻辑，不读取时不修改它。

- [ ] **步骤 4：运行目标测试，确认通过**

运行：`node --test tests/orchestrator-snapshots.test.mjs tests/orchestrator-context-manifest.test.mjs tests/orchestrator-test-sandbox-staging.test.mjs`

预期：全部通过；Linux Docker 专用测试可显示 skipped。

- [ ] **步骤 5：提交**

```text
git add scripts/orchestrator/service.mjs scripts/orchestrator/git-worktree.mjs tests/orchestrator-snapshots.test.mjs tests/orchestrator-context-manifest.test.mjs tests/orchestrator-test-sandbox-staging.test.mjs
git commit -m "feat(orchestrator): store task files in readable workspaces"
```

### 任务 3：调整安装脚本、文档与安装验证

**文件：**
- 修改：`scripts/install.ps1`
- 修改：`scripts/install.sh`
- 修改：`tests/validate-install.test.mjs`
- 修改：`README.md`
- 修改：`docs/superpowers/specs/2026-08-28-readable-workspace-layout-design.md`

**接口：**
- 安装脚本创建 `<projectRoot>/work/`，但不再创建新的 `runtime/worktrees`、`runtime/artifacts`。
- 安装清单中的受保护原始产物根改为 `<projectRoot>/work/`，字段名称保持兼容。

- [ ] **步骤 1：写出失败安装测试**

在 `validate-install.test.mjs` 的 PowerShell 与 Bash 安装 fixture 中断言 `work/` 已创建，且新建安装目录不存在 `runtime/worktrees` 与 `runtime/artifacts`；断言 dry-run manifest 的 `artifact_access_control.path_abs` 指向项目根的 `work/`。

- [ ] **步骤 2：运行安装测试，确认失败**

运行：`node --test tests/validate-install.test.mjs`

预期：新目录与 manifest 路径断言失败。

- [ ] **步骤 3：修改安装与文档**

PowerShell 和 Bash 的目录初始化改为创建 `Join-Path $ProjectRoot 'work'` / `"$PROJECT_ROOT/work"`，并将原始产物访问控制指向该目录。README 的运行时布局改为说明 `work/<项目名>-<任务摘要>/{repo,input,output,logs}`，明确旧 runtime 数据不会迁移；保持现有 Windows/Linux 普通更新和 Windows 安全重装命令完全一致。

- [ ] **步骤 4：运行安装与全量验证**

运行：`node --test tests/validate-install.test.mjs; npm test`

预期：安装测试与完整测试套件通过；平台专属 Docker 测试可显示 skipped。

- [ ] **步骤 5：提交**

```text
git add scripts/install.ps1 scripts/install.sh tests/validate-install.test.mjs README.md docs/superpowers/specs/2026-08-28-readable-workspace-layout-design.md
git commit -m "feat(install): create readable work area"
```
