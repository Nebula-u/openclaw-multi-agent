# 发布就绪报告（Release Readiness Report）

> 由 release-agent 生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 凡涉及事实处必须用分类占位：`[OBSERVED: ...]` / `[INFERRED: ...]` / `[PROPOSED: ...]` / `[UNKNOWN: ...]`。禁止编造。
> verdict 仅可为 `GO` | `NO_GO` | `HOLD`；`GO` 仅表示 `READY_FOR_OPERATIONS_HANDOFF`，不代表已部署。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `release-agent`
- candidate_commit: `PLACEHOLDER_CANDIDATE_COMMIT_SHA`
- evaluated_at: `2026-01-01T00:00:00Z`
- isolation_mode: `UNSANDBOXED_LOCAL`

## 证据汇总（Evidence Roll-up）
> 汇总各阶段证据与门禁状态；status ∈ PASS | FAIL | HOLD | UNKNOWN | NOT_APPLICABLE。
> `release-decision.json` 顶层 `evidence_refs` 与每个 `checks[].evidence_refs` 必须非空，并只引用本 task/run 的 `evidence.jsonl`。

| 领域 | 来源报告 / gate | status | 证据 |
|------|-----------------|--------|------|
| 需求（requirements） | requirement-report.md | `<PLACEHOLDER>` | `[证据: EVD-...]` |
| 架构（architecture） | architecture-report.md | `<PLACEHOLDER>` | `[证据: EVD-...]` |
| 开发（development） | development-report.md | `<PLACEHOLDER>` | `[证据: EVD-...]` |
| 审查（review） | review-report.md | `<PLACEHOLDER>` | `[证据: EVD-...]` |
| 测试（test） | test-report.md | `<PLACEHOLDER>` | `[证据: EVD-... / CMD-...]` |
| 构建（build） | <PLACEHOLDER> | `<PLACEHOLDER>` | `[证据: CMD-...]` |
| 安全（security） | <PLACEHOLDER> | `<PLACEHOLDER: 若未执行标 UNKNOWN>` | `[UNKNOWN: NOT_EXECUTED]` |

## 候选 commit 一致性核对（Commit Consistency）
- candidate_commit: `PLACEHOLDER_CANDIDATE_COMMIT_SHA`
- reviewed_commit（review-report）: `PLACEHOLDER_REVIEWED_COMMIT_SHA`
- tested_commit（test-report）: `PLACEHOLDER_TESTED_COMMIT_SHA`
- commit_matches_review_and_test: `<PLACEHOLDER: true | false>`
- <PLACEHOLDER: 若三者不一致，必须说明并倾向 NO_GO 或 HOLD。>

## 构建产物与校验和（Build Artifacts & Checksums）
| 产物（绝对路径） | sha256 | 证据 |
|------------------|--------|------|
| `<ABS_ARTIFACT_PATH>` | `<sha256>` | `[证据: EVD-... / CMD-...]` |

## 回滚计划（Rollback Plan）
- rollback_plan_present: `<PLACEHOLDER: true | false>`
- <PLACEHOLDER: 回滚步骤、回滚目标 commit、数据 / 迁移回退注意事项。>

## 运维交接与部署前置条件（Ops Handoff & Prerequisites）
- ops_handoff_present: `<PLACEHOLDER: true | false>`
- <PLACEHOLDER: 部署前置条件、配置 / 密钥要求、监控 / 告警、责任人交接清单。>

## 判定（Verdict）
- verdict: `<PLACEHOLDER: GO | NO_GO | HOLD>`
- verdict_meaning: `GO == READY_FOR_OPERATIONS_HANDOFF (not deployed)`
- 重算规则：任一 `HOLD` / `UNKNOWN` / `NOT_APPLICABLE` → `HOLD`；否则任一 `FAIL` → `NO_GO`；非空且全 `PASS` → `GO`；空 checks → `HOLD`。
- 理由：<PLACEHOLDER: 基于证据汇总、commit 一致性、回滚与运维交接完备性给出判定理由。>

## 已知问题（Known Issues）
<PLACEHOLDER: 逐条列出遗留问题及其严重度与影响。>

## 限制与未解决项（Limitations & Unresolved）
<PLACEHOLDER: 未验证领域（如 security `[UNKNOWN: NOT_EXECUTED]`）与需人工决策项。>
