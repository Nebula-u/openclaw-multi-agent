# sandboxed-test-policy.md — 强制轻量级沙箱测试策略

> 版本: sandboxed-test-policy v1
> 适用对象: `test-agent` 新 run
> 权威实现: `config/test-sandbox-policy.json`、`scripts/orchestrator/sandbox-runtime.mjs`

## 1. 强制结论

所有新 `test-agent` run 必须使用 `isolation_mode=SANDBOXED_DOCKER`。沙箱准备、动态挂载、有效配置、容器运行时或 attestation 任一环节失败，任务返回 `BLOCKED`；禁止以 `UNSANDBOXED_LOCAL` 继续，也禁止隐式继承宿主机执行。

## 2. 轻量级运行基线

- OpenClaw: `mode=all`、`backend=docker`、`scope=session`、`workspaceAccess=none`。
- 镜像: `openclaw-test-node:22-slim`，非 root 用户，Node 22、git、ripgrep、Python 运行目标项目测试所需的最小工具。
- Docker: `network=none`、`readOnlyRoot=true`、`capDrop=["ALL"]`、`pidsLimit=256`、内存 `2g`、CPU `2`、工作目录 `/workspace`。
- 不挂载 Docker socket，不在运行时安装依赖或启动服务。

## 3. 每次 run 的挂载

| 容器路径 | 模式 | 内容 |
| --- | --- | --- |
| `/worktree` | `rw` | 当前 task 的独立 Git worktree |
| `/input` | `ro` | 任务、context manifest 与已声明输入的副本 |
| `/agent-raw` | `rw` | Agent 暂存的 JSON/JSONL 输出 |
| `/raw-logs` | `rw` | 原始 stdout/stderr 与测试日志 |

Agent 使用 `/worktree`、`/input`、`/agent-raw`、`/raw-logs` 和 `/workspace`；`input` 文件在进入容器前按 manifest 校验 SHA-256。宿主机绝对路径只作为审计元数据，不作为容器内访问路径。

## 4. 证据与结果

每次 test-agent 命令记录必须使用 `isolation_mode=SANDBOXED_DOCKER`，并在 `command-records.jsonl`、`test-report.md`、`result.json` 中保留运行时 ID、容器 ID、镜像 digest、挂载和资源边界引用。结果必须包含：

```json
{
  "isolation_mode": "SANDBOXED_DOCKER",
  "sandbox_attestation": {
    "backend": "docker",
    "mode": "all",
    "scope": "session",
    "network": "none",
    "host_execution": false
  }
}
```

上述示例仅表达字段要求；实际值必须来自本次 run 的真实 attestation，禁止使用占位或伪造值。

## 5. 默认禁止

网络访问、依赖安装、访问凭证目录、系统配置修改、服务控制、计划任务、注册表修改、远程 Git 和破坏性命令仍默认禁止。需要越权时返回 `HUMAN_DECISION_REQUIRED`，而不是关闭沙箱。

## 6. 历史兼容

历史 artifact 可以保留 `UNSANDBOXED_LOCAL`，用于真实记录迁移前状态；它不能支撑新 test-agent 的 TestGate/ReleaseGate PASS。历史策略说明见 [`docs/unsandboxed-test-policy.md`](unsandboxed-test-policy.md)。
