# 01 · git 回滚点分析与决策

> 历史计划：已由 2026-08-21 SQLite + Git snapshot 方案取代，不得执行本文命令。

> 目的：为「引入 Control Kernel + PostgreSQL 重构」选定一个干净、可复现、不丢关键修复的起点。
> 结论优先：**不做 `git reset`。从 `49e9143` 新建分支，用一次显式删除提交达到等价于 `7336b0a` 的架构干净度。**

---

## 1. 当前仓库状态（事实）

分支：`codex/stategraph-checkpointer-rebuild`，HEAD = `49e9143`。

工作区**有大量未提交改动**：

```text
 M README.md
 M agents/manager-agent/workspace/AGENTS.md
 M config/monitoring.example.json
 M contracts/route-plan.schema.json
 M docs/monitoring.md
 M extensions/stategraph-webchat/index.js
 M extensions/stategraph-webchat/openclaw.plugin.json
 M monitor/config.mjs
 M monitor/server.mjs
 M monitor/ui/app.js
 M monitor/ui/index.html
 M monitor/ui/styles.css
 M scripts/stategraph/agent-runner.mjs
 M scripts/stategraph/dispatcher.mjs
 M scripts/stategraph/graph.mjs
 M scripts/stategraph/policy.mjs
 M scripts/stategraph/runtime.mjs
 M scripts/stategraph/state.mjs
 M tests/monitor-http.test.mjs
 M tests/monitor-static-dashboard.test.mjs
 M tests/stategraph-dispatcher.test.mjs
 M tests/stategraph-policy.test.mjs
 M tests/stategraph-runtime.test.mjs
 M tests/stategraph-sandbox.test.mjs
 D tests/stategraph-webchat-bridge.test.mjs
 M tests/stategraph-webchat-plugin.test.mjs
?? .agent-raw/
?? scripts/stategraph/ephemeral-schema.mjs
?? scripts/stategraph/manager-request-queue.mjs
?? tests/stategraph-manager-queue.test.mjs
?? workspace/
```

这批未提交改动的**实际内容**是一次完整且自洽的演进：

1. `webchat-bridge.mjs`（对话式桥）被 `manager-request-queue.mjs`（文件队列 + 收据）取代，因此 `tests/stategraph-webchat-bridge.test.mjs` 被删除，新增 `tests/stategraph-manager-queue.test.mjs`。
2. 新增 `ephemeral-schema.mjs`：一次性把 JSON Schema 注入 prompt，用完即释放。
3. `state.mjs` 新增 `workflowTitle` / `routeHistory` / `confirmedRoutePlan` / `routeChangeCommand` 四个通道，`graph.mjs` 相应新增 `apply_route_change` 节点与 `freezeConfirmedPlan()`。
4. `extensions/stategraph-webchat/index.js` 收敛为 `before_prompt_build` + `gateway_start`/`gateway_stop`，由定时器驱动队列 `scan()`。
5. Monitor UI 与 `publicWorkflow.title` 对齐 `workflowTitle`。

**判断：这批改动是资产，不是包袱。** 它已经把「Manager 以结构化请求驱动 workflow」这条链路做通了，正是 Control Kernel 的上游入口形态。丢掉它等于白重做一遍。

---

## 2. 提交时间线与性质判定

```text
49e9143  docs: 核对docs与代码实际状态                     ← HEAD，纯文档
065fbab  修复StateGraph自然回复与Monitor启动               ← 含必须保留的修复
8682934  修复交互会话的StateGraph接管与Windows派发         ← 含必须保留的修复
ca125e0  接通 OpenClaw WebChat 与 StateGraph 工作流        ← 引入 webchat-bridge.mjs（已被取代）
8cd0b8a  回滚未接通 WebChat 的 StateGraph 接入实现          ← 回滚提交
8485325  新增 Stategraph Intake Bridge 插件及相关配置文件    ← 失败尝试，已被 8cd0b8a 回滚
cda9d04  新增 StateGraph 需求接入控制器                    ← 失败尝试，已被 8cd0b8a 回滚
7336b0a  更新：调整代理的 delegationMode 为 prefer          ← ★ 最后一个「webchat 实验之前」的干净点
935eb74  文档：添加外部维护 Agent 同步提醒及更新命令说明
17ab45d  更新：添加workbuddy相关文件到.gitignore
30a7358  清理：归档无沙箱旧默认策略
b962ba9  文档：迁移StateGraph单框架运行与恢复说明            ← 文档已全面迁到 StateGraph 单框架
c6b3b2f  测试：补齐候选提交与沙箱异常恢复
6976bff  配置：统一200k模型上限与安装可信边界
2cc17ac  清理：删除旧三层框架与Java监控代理                  ← 旧 Control Kernel / Orchestrator 在此被删
77a58fc  规则：统一Worker的StateGraph可信边界
d776149  重建：固化StateGraph检查点与Node监控基线           ← StateGraph + SQLite checkpointer 首次落地
ef850ce  refactor(workflow): 将具名路由边收敛到 Control Kernel
```

### 2.1 必须保留的两处修复

| 提交 | 文件 | 修复内容 | 为什么不能丢 |
| --- | --- | --- | --- |
| `8682934` | `scripts/stategraph/git-worktree.mjs` | `pathKey()` 用 sha256 前 20 位生成 worktree 目录名 | 不加这个修复，Windows 上 `git worktree add` 会因为路径过长报 `'$GIT_DIR' too big`，**整条派发链路在 Windows 直接不可用**。当前开发机就是 Windows。 |
| `065fbab` | `monitor/server.mjs`、`monitor/main.mjs`、`monitor/session-parser.mjs` | `sendAsset()` / `uiAssets` 静态资源托管；session 时间戳解析修复 | 用户明确要求「**保留 monitor 的监测功能和 UI 界面**」。没有 `uiAssets`，`/`、`/index.html`、`/styles.css`、`/app.js`、`/config.js` 五个入口全部 404，UI 界面就没了。 |

### 2.2 唯一需要清除的包袱

`ca125e0` 引入的 `scripts/stategraph/webchat-bridge.mjs`（76 行，`createWebchatWorkflowBridge` / `isApprovalMessage` / `formatWorkflowReply`）。它的职责已经 100% 被未提交的 `manager-request-queue.mjs` 覆盖，其测试文件也已在工作区被删。**它是唯一在 `7336b0a` 之后进入仓库、且在目标架构里没有位置的文件。**

---

## 3. 三个候选方案对比

### 方案 A — `git reset --hard 7336b0a`（教科书式回滚）

| 项 | 评价 |
| --- | --- |
| 干净度 | 最高，webchat 实验完全消失 |
| 代价 | 必须 cherry-pick `8682934` 与 `065fbab`，但这两个提交里**混合**了要保留的修复和要丢弃的 webchat 逻辑，cherry-pick 一定冲突，需要手工拆分 |
| 风险 | **高**。当前 26 个已修改文件 + 4 个新文件的未提交改动是基于 `49e9143` 的树写的；reset 后这些 diff 的上下文行大量不匹配，`git stash pop` 会产生几十处冲突，极易在解冲突时静默丢代码 |
| 结论 | ❌ 不采用。收益是「历史好看」，代价是「真实丢代码风险」，不划算 |

### 方案 B — 从 `49e9143` 新建分支 + 一次显式删除提交（**采用**）

| 项 | 评价 |
| --- | --- |
| 干净度 | 与方案 A **等价**。因为 `7336b0a → 49e9143` 之间，除了 `webchat-bridge.mjs` 这一个文件，其余全是必须保留的修复 + 文档 + 已被工作区取代的测试 |
| 代价 | 零冲突。未提交改动原样保留 |
| 可追溯性 | 更好。删除动作是一个有中文说明的独立提交，而不是一段消失的历史 |
| 结论 | ✅ **采用** |

### 方案 C — 直接在当前分支上继续

| 项 | 评价 |
| --- | --- |
| 结论 | ❌ 违反项目规约。`AGENTS.md` 第 6 条要求「大型修改前必须创建 `workbuddy/ change something` 格式的分支」 |

---

## 4. 最终决策

### 4.1 起点定义

```text
起点 commit : 49e9143（docs: 核对docs与代码实际状态）
新建分支    : workbuddy/control-kernel-postgres
等价基线    : 7336b0a（webchat 实验之前的最后一个干净点）
```

**「等价基线」的含义**：执行下面的 P0 步骤之后，仓库树在架构意义上等同于「从 `7336b0a` 出发、并已 cherry-pick 全部必要修复」的状态。

### 4.2 P0 落地步骤（本计划批准后才执行）

```bash
# 1) 先把当前未提交改动固化成一个提交，避免任何丢失
git checkout -b workbuddy/control-kernel-postgres
git add -A
git commit -m "基线：固化Manager请求队列与一次性Schema注入的未提交改动"

# 2) 用一次显式提交清除已被取代的 webchat 桥
git rm scripts/stategraph/webchat-bridge.mjs
git commit -m "清理：删除已被Manager请求队列取代的WebChat桥接模块"

# 3) 确认基线可用
npm test
```

> 注意：`.agent-raw/` 与 `workspace/` 两个未跟踪目录是运行时产物，在第 1 步之前应确认已被 `.gitignore` 覆盖；若未覆盖，先补 `.gitignore` 再提交，不要把运行时垃圾提进仓库。

### 4.3 决策的三条依据

1. **保住 Windows 可用性。** `pathKey()` 缺失 = 派发链路在当前开发机上完全不能跑。
2. **保住用户明确要求的 Monitor UI。** `uiAssets` 缺失 = UI 五个入口全 404。
3. **保住已经做通的 Manager 入口。** 未提交的 `manager-request-queue.mjs` 是 Control Kernel 的天然上游，重做纯属浪费。

### 4.4 备选（仅在 P0 验证失败时启用）

如果 P0 的 `npm test` 暴露出未提交改动本身存在结构性缺陷、无法在合理成本内修复：

```bash
git branch workbuddy/salvage-manager-queue   # 先给现状留一个救援分支
git reset --hard 7336b0a
# 然后从 salvage 分支手工挑回：
#   scripts/stategraph/git-worktree.mjs 的 pathKey()
#   monitor/server.mjs 的 sendAsset/uiAssets
#   monitor/session-parser.mjs 的时间戳修复
#   scripts/stategraph/{ephemeral-schema,manager-request-queue}.mjs
```

即退回方案 A，但**必须先建救援分支**。

---

## 5. 与重构范围的边界

回滚点决策只负责「从哪儿开始」。以下内容属于重构本身，在 [`04-implementation-plan.md`](./04-implementation-plan.md) 中处理，**不在 P0 做**：

- 删除遗留空目录 `scripts/control-core/`、`scripts/monitor-core/`、`scripts/orchestrator/`（`docs/architecture.md` 已注明可直接删除）
- 归档旧 Control Kernel 的 SQLite 遗留数据 `runtime/control/control.db`
- 新增 `pg` 依赖
- Checkpointer 从 `node:sqlite` 迁移到 PostgreSQL

---

## 6. 检查清单

P0 完成后必须逐项确认：

- [ ] 分支名为 `workbuddy/control-kernel-postgres`
- [ ] `git log --oneline -3` 显示两条中文提交
- [ ] `scripts/stategraph/webchat-bridge.mjs` 已不存在
- [ ] `grep -rn "webchat-bridge" scripts tests extensions` 无残留引用
- [ ] `scripts/stategraph/git-worktree.mjs` 中 `pathKey` 存在
- [ ] `monitor/server.mjs` 中 `uiAssets` 与 `sendAsset` 存在
- [ ] `npm test` 全绿
- [ ] `curl -s http://127.0.0.1:4319/ | head -5` 返回 HTML（UI 存活）
