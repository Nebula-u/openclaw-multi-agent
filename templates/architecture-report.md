# 架构设计报告（Architecture Report）

> 由 architect-agent 生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 凡涉及事实处必须用分类占位：`[OBSERVED: ...]` / `[INFERRED: ...]` / `[PROPOSED: ...]` / `[UNKNOWN: ...]`。禁止编造。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `architect-agent`
- input_commit: `PLACEHOLDER_INPUT_COMMIT_SHA`
- generated_at: `2026-01-01T00:00:00Z`
- isolation_mode: `UNSANDBOXED_LOCAL`

## 证据分类说明
- `OBSERVED` / `INFERRED` / `PROPOSED` / `UNKNOWN`，均附证据引用 `[证据: EVD-... / CMD-...]` 或来源文件。

## 架构概述（Architecture Overview）
<PLACEHOLDER: 总体架构风格与关键决策概述，多为 `[PROPOSED: ...]`。>

## 模块划分（Modules）
<PLACEHOLDER: 模块清单，每个模块的职责 / 边界 / 依赖。>

## 接口（Interfaces）
<PLACEHOLDER: 对外 / 对内接口签名、协议、契约；标注稳定性与版本。>

## 数据模型（Data Model）
<PLACEHOLDER: 实体 / 字段 / 约束 / 关系；引用相关 schema（英文字段名）。>

## 数据流（Data Flow）
<PLACEHOLDER: 关键路径的数据流转与状态迁移；可用文字步骤描述。>

## 风险清单（Risk Register）
| risk_id | 描述 | 可能性 | 影响 | 缓解措施 | 分类 |
|---------|------|--------|------|----------|------|
| RISK-001 | <PLACEHOLDER> | <低/中/高> | <低/中/高> | <PLACEHOLDER> | `[INFERRED: ...]` |

## 威胁模型（Threat Model）
<PLACEHOLDER: 资产 / 信任边界 / 威胁（如 STRIDE）/ 对策；标注 `[UNKNOWN: ...]` 未评估项。>

## 测试策略（Test Strategy）
<PLACEHOLDER: 单元 / 集成 / 端到端策略；覆盖目标；与 AC-001 等验收标准的对应关系。>

## ADR 引用（ADR References）
<PLACEHOLDER: 相关架构决策记录（ADR）编号与绝对路径引用。>

## 追踪关系（Traceability）
<PLACEHOLDER: AC ↔ 模块 / 接口 / 数据模型 的映射表。>

## 限制与未解决项（Limitations & Unresolved）
<PLACEHOLDER: 设计限制、未决权衡与需人工决策项（`[UNKNOWN: ...]`）。>
