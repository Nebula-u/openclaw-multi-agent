# 测试报告（Test Report）

> 由 test-agent 生成。散文用中文，字段名 / 命令 / 标识符用英文。
> 凡涉及事实处必须用分类占位：`[OBSERVED: ...]` / `[INFERRED: ...]` / `[PROPOSED: ...]` / `[UNKNOWN: ...]`。禁止编造；所有数量与退出码须来自真实 command-record 与日志。

## 元信息（Metadata）
- workflow_id: `WF-00000000-0000-0000-0000-000000000000`
- task_id: `TASK-00000000-0000-0000-0000-000000000000`
- run_id: `RUN-00000000-0000-0000-0000-000000000000`
- assigned_agent: `test-agent`
- tested_commit: `PLACEHOLDER_TESTED_COMMIT_SHA`
- generated_at: `2026-01-01T00:00:00Z`

## 隔离与风险披露（Isolation & Risk Disclosure）
- isolation_mode: `UNSANDBOXED_LOCAL`
- <PLACEHOLDER: 说明 test-agent 在本机非隔离环境执行测试（`sandbox.mode=off`），命令直接作用于本地文件系统与进程。>
- 风险披露：<PLACEHOLDER: 列出非隔离执行的潜在副作用（本地文件 / 网络 / 端口 / 全局状态），以及已采取的约束（仅在 worktree_path_abs 内操作）。>

## 执行的测试命令（Executed Commands）
> 每条命令须对应一条 command-record；退出码 / 日志路径 / 哈希不得编造。

| command | command_record_id | exit_code | stdout_path_abs | stderr_path_abs | stdout_sha256 | retry | flaky |
|---------|-------------------|-----------|-----------------|-----------------|---------------|-------|-------|
| `npm run test` | CMD-0001 | 0 | `C:\path\to\...\logs\cmd-0001.stdout.txt` | `C:\path\to\...\logs\cmd-0001.stderr.txt` | `0000...0000` | 0 | false |
| `<PLACEHOLDER>` | <CMD-...> | <PLACEHOLDER> | `<ABS_PATH>` | `<ABS_PATH>` | `<sha256>` | <n> | <true/false> |

## 结果汇总（Result Summary）
> 数量须与日志一致；无法确定的项标 `[UNKNOWN: ...]`。

| 指标 | 数量 |
|------|------|
| found（发现/收集用例数） | <PLACEHOLDER> |
| passed（成功） | <PLACEHOLDER> |
| failed（失败） | <PLACEHOLDER> |
| skipped（跳过） | <PLACEHOLDER> |
| errors（错误） | <PLACEHOLDER> |

## 重试与 flaky 标记（Retries & Flaky）
<PLACEHOLDER: 说明是否发生重试、判定为 flaky 的用例及依据（`[OBSERVED: ...]`）。>

## 验收标准覆盖（Acceptance Criteria Coverage）
| ac_id | 覆盖的测试 | 结果 | 证据 |
|-------|-----------|------|------|
| AC-001 | <PLACEHOLDER> | `[OBSERVED: PASS/FAIL]` | `[证据: EVD-... / CMD-...]` |

## 是否修改生产代码（Production Code Modified）
- production_code_modified: `<PLACEHOLDER: true | false>`
- <PLACEHOLDER: 若为 true，说明修改原因与范围；test-agent 原则上不应改动生产代码。>

## UNKNOWN 项
<PLACEHOLDER: 未能确定或未执行的检查，逐条标 `[UNKNOWN: ...]`。>

## 限制与未解决项（Limitations & Unresolved）
<PLACEHOLDER: 测试覆盖限制、环境阻塞与需人工决策项。>
