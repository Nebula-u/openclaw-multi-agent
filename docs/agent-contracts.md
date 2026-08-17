# Agent 运行契约

## 通用身份

每个 worker 只接受 StateGraph dispatch 创建的 task。task 固定包含 workflow、step、run、Agent、attempt、input commit、worktree、artifact root、context manifest 和 Gate checks。

Agent 必须：

- 核对自身 ID、run、attempt、路径和 manifest SHA；
- 只在授权 worktree、`.agent-raw` 和 raw log 路径写入；
- 保留真实命令、stdout、stderr、失败和限制；
- 返回 checkpoint 指定的 input commit；
- 不调用其他 Agent、不审批、不改路线、不推进状态。

## 结构化输出

Manager 输出 `route-plan.json.raw`；worker 输出 `result.json.raw`。Agent 不直接写 `output/` 或 ingestion receipt。

result 的身份字段必须与 task 完全一致。`report_files`、`command_record_refs`、`evidence_refs` 只能引用授权根内普通非 symlink 文件。自检只是候选信息，不能替代宿主 ingestion/Gate。

`result_status` 允许：`COMPLETED`、`NEEDS_REWORK`、`BLOCKED`、`HUMAN_DECISION_REQUIRED`、`FAILED`。`HOLD` 是 StateGraph condition，不是 Agent result status。

## Git

DEVELOPMENT 和 TEST 返回完整 `output_commit`。该 commit 必须存在、基于 input commit 并等于 worktree HEAD。TEST 无修改时返回 input commit；REQUIREMENTS、ARCHITECTURE、DESIGN、REVIEW、RELEASE 不得替换 candidate。

## TEST

test-agent 固定使用 `SANDBOXED_DOCKER`，实际执行路径为 `/worktree`、`/input`、`/agent-raw`、`/raw-logs`。禁止主机执行、网络、提权和额外 mount。

TEST result 和 CommandRecord 必须声明 `SANDBOXED_DOCKER`，并包含代码验证的 sandbox attestation。第一次失败即使后续通过也应保留证据并报告潜在 flaky。

## 角色差异

- requirement-agent：范围、边界、验收标准。
- architect-agent：架构/设计、接口、风险和测试策略。
- developer-agent：实现代码并提交候选。
- review-agent：审查 checkpoint candidate，输出发现与回归风险。
- test-agent：补充/执行测试并提交测试证据或测试 commit。
- release-agent：绑定最终 candidate，核查回滚与发布准备，不执行部署。

## 重试

JSON repair 使用同一 session，只重写结构化文件，最多 2 次。task attempt 重试使用新 run/session/worktree，最多 3 次。Agent 不自行决定或隐瞒重试。

## 完整契约清单

本文只覆盖 Agent 直接读写的输出契约。`contracts/` 目录当前共 22 个 schema，其余（`approval-request/response/assessment.schema.json`、`agent-package.schema.json`、`skill-package.schema.json`、`component-request/build-result.schema.json`、`gate-result.schema.json`、`release-decision.schema.json` 等）由代码内部在审批、组件管理、Gate 和发布决策环节使用，Agent 不直接读写这些文件。
