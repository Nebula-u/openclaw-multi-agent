# 扫雷游戏项目 — Token 使用报告

> Workflow: WF-minesweeper-002 | Outcome: READY_FOR_OPERATIONS_HANDOFF  
> 生成时间: 2026-08-07T08:20:00+08:00

## 总体概况

| 指标 | 数值 |
|------|------|
| 总 Agent 会话数 | **10** |
| 总 Input Tokens | **679,384** |
| 总 Output Tokens | **504,368** |
| 总 Cache Read | **28,357,120** |
| **合计 Token 消耗** | **29,540,872** |

## 各 Agent 明细

| Agent | 会话数 | Input | Output | Cache Read | Total | 占比 |
|-------|--------|-------|--------|------------|-------|------|
| requirement-agent | 5 | 303,988 | 224,688 | 12,055,040 | 12,583,716 | 42.6% |
| developer-agent | 2 | 124,124 | 78,094 | 4,982,784 | 5,185,002 | 17.6% |
| test-agent | 1 | 88,108 | 68,766 | 4,357,888 | 4,514,762 | 15.3% |
| review-agent | 1 | 87,494 | 51,754 | 3,718,144 | 3,857,392 | 13.1% |
| architect-agent | 1 | 75,670 | 81,066 | 3,243,264 | 3,400,000 | 11.5% |

### Token 分布图（按 Agent）

```
requirement-agent ██████████████████████████████████████████ 42.6%
developer-agent   █████████████████ 17.6%
test-agent        ███████████████ 15.3%
review-agent      █████████████ 13.1%
architect-agent   ███████████ 11.5%
```

## 阶段分析

| 流水线阶段 | Agent | 会话 | Total Tokens | 说明 |
|-----------|-------|------|-------------|------|
| REQUIREMENTS | requirement-agent | 5 | 12,583,716 | 最多会话（含重试），Preflight失败、Schema修复等 |
| ARCHITECTURE | architect-agent | 1 | 3,400,000 | 一次完成，产出9模块+4项ADR+12任务 |
| DEVELOPMENT | developer-agent | 2 | 5,185,002 | 首次worktree错误+二次成功 |
| CODE_REVIEW | review-agent | 1 | 3,857,392 | 一次完成，APPROVE，6 findings |
| TESTING | test-agent | 1 | 4,514,762 | 一次完成，71/71 pass |

## Token 类型分布

| 类型 | 数量 | 占比 |
|------|------|------|
| Cache Read | 28,357,120 | 96.0% |
| Input (Prompt) | 679,384 | 2.3% |
| Output (Completion) | 504,368 | 1.7% |

> **注**: Cache Read 占比较高（96%），说明系统 prompt、规则文件、上下文包等固定内容被重复读取和缓存。实际新增的输入/输出 token 约 1.2M。

## 注意事项

- **manager-agent** 未计入统计（其会话为当前 WebChat 对话，属于编排协调，非工作产出）
- 本报告基于 OpenClaw agent trajectory 文件中的 usage 字段统计
- 会话数包含重试（requirement-agent 的 5 次会话中含 Preflight 失败、Schema 修复等重试）

## 本轮调整约束

- Demo 快速流程不默认启用，必须在 `INTAKE` 阶段经过真实人工审批；批准后跳过 requirement、architect、review、test、release Agent，仅保留 developer 与本地测试。
- 新 workflow 只使用 Control Kernel v2 的 `phase + condition`；待人工状态为 `condition=WAITING_HUMAN`，审批对象的 `status=PENDING` 不作为 workflow 状态。
- OpenClaw 当前已设置 `agents.defaults.contextLimits.toolResultMaxChars=12000`。这是单次工具结果的上下文上限，不禁用工具；大文件通过分段读取，避免一次性把完整日志/源码反复带入后续 API 请求。
- 不调整各角色模型，也不启用按任务动态模型路由。
