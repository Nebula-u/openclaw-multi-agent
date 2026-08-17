# Architecture Review and Target Design

> **历史存档说明（2026-08-17 补注）**：本报告基于 2026-07-30 时点的旧三层架构撰写，已被 2026-08-14 的 LangGraph `StateGraph + checkpointer` 重建取代（见 `docs/report/2026-08-14-stategraph-rebuild-handoff.md`）。仅供历史参考，当前架构见 `docs/architecture.md`。
>
> 报告日期：2026-07-30  
> 主题：面向个人/小团队的多 Agent 软件开发系统最终架构建议  
> 资源约束：单服务器、4 核 CPU、4GB 内存、API 调用模型。

## 1. 当前架构判断

当前架构的优点是非常清楚的：

1. 角色职责明确，适合模拟真实 SDLC。
2. manager-agent 是唯一入口，减少多 Agent 互相调用失控。
3. Agent workspace 独立，便于隔离规则和身份。
4. JSON Schema、Runtime Guard、Gate、事件链、本地 Git worktree 都是生产化方向。
5. 当前明确承认 `UNSANDBOXED_LOCAL` 风险，没有把本地测试误称为完全隔离。

主要不足：

1. Agent 数量对小团队使用偏多，带来 token 和状态成本。
2. LangGraph 在当前仓库中还不是运行主路径，更多是后续可接入能力。
3. release-agent 当前只能做到运维前交付，不具备真实部署闭环。
4. review/test/security/devops 边界需要重新收敛。
5. 状态和成本治理应比新增 Agent 更优先。

## 2. 最终推荐架构

### 2.1 架构图

```text
┌─────────────────────────────────────────────────────────────┐
│ User / CLI / Chat / Web UI                                  │
└───────────────────────────────┬─────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────┐
│ manager-agent                                                │
│ - intake / routing / workflow state                          │
│ - approvals / gates / final report                           │
│ - context summary / cost budget                              │
└──────────────┬────────────────┬────────────────┬────────────┘
               │                │                │
               ▼                ▼                ▼
┌──────────────────────┐ ┌──────────────────┐ ┌────────────────────┐
│ product-requirement  │ │ design-agent     │ │ implementation     │
│ - scope              │ │ - architecture   │ │ - code changes     │
│ - AC                 │ │ - data/interface │ │ - branch/commit    │
│ - clarification      │ │ - test strategy  │ │ - local verify     │
└──────────┬───────────┘ └────────┬─────────┘ └────────┬───────────┘
           │                      │                    │
           └──────────────────────┼────────────────────┘
                                  ▼
                         ┌──────────────────┐
                         │ quality-agent    │
                         │ - code review    │
                         │ - test execution │
                         │ - light security │
                         └────────┬─────────┘
                                  ▼
                         ┌──────────────────┐
                         │ release-ops      │
                         │ - readiness      │
                         │ - handoff        │
                         │ - rollback plan  │
                         │ - optional deploy│
                         └────────┬─────────┘
                                  ▼
                         ┌──────────────────┐
                         │ artifacts/state  │
                         │ JSONL + SQLite   │
                         │ Git worktrees    │
                         │ Runtime Guard    │
                         └──────────────────┘
```

### 2.2 Agent 数量

推荐常驻 6 个 Agent：

| Agent | 来源于当前角色 | 职责 |
|---|---|---|
| `manager-agent` | 保留 | 唯一入口、调度、状态、审批、Gate、成本预算 |
| `product-requirement-agent` | requirement + product | 需求澄清、范围、验收标准、用户价值 |
| `design-agent` | architect | 架构、接口、数据模型、测试策略 |
| `implementation-agent` | developer | 代码实现、Git、依赖、最小验证 |
| `quality-agent` | review + test + light security | 审查、测试执行、基础安全扫描 |
| `release-ops-agent` | release + light devops | 发布前检查、运维交接、回滚建议、可选部署 |

按需启用能力：

| 能力 | 触发条件 |
|---|---|
| security specialist | 认证、权限、支付、隐私、供应链、高危依赖 |
| database specialist | migration、索引、数据兼容、性能 |
| documentation specialist | 用户文档/API 文档/教程型交付 |
| UX specialist | 复杂前端体验或设计系统 |

这样比当前 7 Agent 更适合个人/小团队：常驻 Agent 更少，跨 Agent 切换更少，token 固定成本更低；同时保留必要质量门禁。

## 3. 技术栈

### 3.1 推荐技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| Agent Runtime | OpenClaw | workspace、会话、工具、渠道入口 |
| Workflow | LangGraph 或 OpenClaw 原生状态机 | 若接入 LangGraph，只做显式状态图，不绕过 Guard |
| Schema 校验 | Node.js Runtime Guard + Ajv | 本地确定性校验 JSON/JSONL |
| 状态索引 | SQLite | 查询 workflow、task、event、cost、artifact |
| 审计事实 | JSONL + artifact files | 保留 append-only 可审计记录 |
| 代码隔离 | Git worktree | 每个任务/重做/测试独立 worktree |
| 命令执行 | OpenClaw shell tools | 所有命令落盘 stdout/stderr/hash |
| 测试隔离 | Docker/Podman 或受限 sandbox | 第三周开始引入 |
| UI | 可选 Web UI | 用于查看任务进度、审批、报告 |

### 3.2 数据存储

推荐采用“双层存储”：

1. **事实层**：继续使用 JSON/JSONL、Markdown、raw logs、checksums、Git commit。这是审计事实源。
2. **索引层**：新增 SQLite，用于查询任务状态、事件、成本、最近摘要、artifact 路径。

不建议一开始把所有状态都迁移到数据库。JSONL 更适合审计和恢复，SQLite 更适合查询和 UI。

### 3.3 通信方式

单服务器场景：

```text
manager-agent
  ├─ OpenClaw sessions_spawn / sessions_send
  ├─ task context package
  ├─ artifact output
  ├─ Runtime Guard validation
  └─ JSONL event chain + SQLite index
```

不建议立即引入：

- Kafka
- RabbitMQ
- 分布式微服务 API Gateway
- 多节点调度器

这些技术会提高运维复杂度，不符合 4 核 4GB 单服务器约束。

## 4. 工作流设计

### 4.1 推荐状态流

```text
INTAKE
  → REQUIREMENTS
  → REQUIREMENT_GATE
  → DESIGN
  → DESIGN_GATE
  → DEVELOPMENT
  → DEVELOPMENT_GATE
  → QUALITY_REVIEW
  → TEST_EXECUTION
  → QUALITY_GATE
  → RELEASE_READINESS
  → FINAL_REPORT / OPERATIONS_HANDOFF
```

所有阶段都允许进入：

```text
WAITING_HUMAN
HOLD
BLOCKED
FAILED
CANCELLED
```

关键回路：

```text
QUALITY_GATE fail → DEVELOPMENT
TEST fail due test bug → TEST_EXECUTION
TEST fail due design issue → DESIGN
RELEASE hold → TRIAGE
ARCHITECTURE scope conflict → REQUIREMENTS
```

### 4.2 简化点

可以简化：

- 小任务跳过完整 architecture-agent，改用 lightweight design checklist。
- review 和 test 合并到 quality-agent。
- documentation 不常驻，作为 release 输出。
- database/security/devops 默认作为 mode，不作为常驻 Agent。

不能简化：

- 验收标准。
- Git diff/commit。
- 实际测试执行。
- review/test/security Gate。
- 审批与风险接受。
- 原始日志和证据。
- 发布前回滚计划。

## 5. Rule Engine、Tool、LLM 的边界

### 5.1 manager-agent 不应做的事

manager-agent 不应靠 LLM 判断：

- 测试是否真的通过。
- commit 是否存在。
- diff 是否越权。
- JSON 是否合法。
- release 是否满足 Gate。
- 安全扫描是否真实执行。

这些应由 Runtime Guard、Git 命令、测试命令、扫描工具和 Gate 规则完成。

### 5.2 quality-agent 的生产化形态

quality-agent 应做三类事：

1. **Review**：LLM 做语义审查，工具做 lint/type/static scan。
2. **Test**：LLM 设计测试，工具执行测试。
3. **Light security**：secret scan、dependency audit、危险模式检查。

当项目涉及高风险安全场景，再派生 security specialist。

## 6. 部署方式

### 6.1 单服务器部署

推荐部署：

```text
systemd user service:
  - OpenClaw Gateway
  - optional Web UI

project directory:
  - repo source
  - runtime/
  - artifacts/
  - worktrees/
  - sqlite index

sandbox:
  - Docker/Podman runner
  - limited network by default
  - read/write mounted worktree only
```

### 6.2 资源预算

| 资源 | 推荐 |
|---|---|
| CPU | 4 核可用，避免本地大模型 |
| 内存 | 4GB，OpenClaw + Node + SQLite + 小型 sandbox |
| 存储 | 至少 20GB，worktree/artifact/log 会增长 |
| 模型 | API 调用为主，小模型 + 大模型路由 |
| 并发 | 默认 1 个 workflow，最多 2 个 worker 并发 |

4GB 内存下不要追求多 Agent 大并发；可靠性比并发更重要。

## 7. 成本估算

### 7.1 固定成本

| 项 | 估算 |
|---|---:|
| 单服务器 | 由云厂商决定，建议按低配实例预算 |
| 存储 | artifact/log/worktree 增长，建议每项目预留 1-5GB |
| 模型 API | 主要成本，按 token 计费 |

### 7.2 项目级 token 成本

推荐生产预算：

| 项目规模 | 优化后 token 预算 |
|---|---:|
| 小脚本/工具 | 200k-800k |
| 小型 Web App | 1M-3M |
| 中小型业务项目 | 2M-6M |
| 长周期迭代 | 按任务拆分预算，不做一次性全局上下文 |

超过预算时，manager 应进入成本审批：

```text
COST_BUDGET_EXCEEDED → WAITING_HUMAN
```

## 8. 为什么比当前方案更适合真实使用

1. **少 Agent 常驻**：降低 token 固定成本和状态复杂度。
2. **质量合并**：review/test/security light 归一，减少互相转述。
3. **确定性优先**：工具和 Runtime Guard 给事实，LLM 给解释。
4. **适配单服务器**：不引入重型消息队列和分布式服务。
5. **按需扩展**：security/database/docs/devops 作为模式或 specialist，不默认消耗资源。
6. **保留现有资产**：不推翻 package manifest、contracts、Runtime Guard、worktree 设计。

## 9. 与当前系统的迁移方式

不建议直接删除现有 7 Agent。建议分三步：

1. 第二周：保持 7 Agent，先修质量闭环和上下文裁剪。
2. 第三周：引入 quality gate，把 review/test/security 的证据聚合统一。
3. 第四周：在配置层支持角色合并模式，小团队默认 6 Agent，大项目可展开为 7+ specialist。

