# 项目外部维护 Agent 长期记忆

本文件面向修改整个仓库的外部维护 Agent（例如 Codex），不属于 `agents/*/workspace/` 内运行时 Agent 的角色规则，也不得复制进这些 workspace。

## Agent 同步提醒

当改动包含以下任一范围时，在最终交付中必须明确提醒用户更新已安装 Agent，并给出与当前脚本参数一致的命令：

- `agents/<agent-id>/workspace/`；
- `agents/common/`；
- `agents/packages/builtin/*.json` 或生成 Agent package；
- Agent 模型、sandbox、tools、delegation、安装复制模板或 runtime bundle 逻辑；
- 会影响已安装 Agent 行为、workspace 副本或 OpenClaw 配置的其他内容。

默认更新命令：

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

完整安全重装只在注册状态或受管理 runtime 损坏、普通更新不能恢复时建议。它要求用户先手动停止 OpenClaw Gateway 并显式确认：

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

## 命令与文档一致性

1. 修改 `scripts/install.ps1`、`scripts/install.sh`、`scripts/reinstall-agents.ps1`、`scripts/validate-install.*` 或其参数时，必须同步更新 README 的安装、更新、重装和 Linux 命令。
2. 不能记录或建议不存在的 Bash/Python/Node 重装命令；若某平台没有等价实现，明确说明限制和可运行的替代入口。
3. 新增或移除 Agent package、修改 Agent 同步范围后，更新命令必须保持可用，并运行对应 dry-run/validate 测试。
4. 如果本次修改触发上述同步条件，最终回复应先说明“需要更新已安装 Agent”，再给出 Windows/Linux 命令及是否需要停止 Gateway。
5. 日常源码变更不触及上述范围时，不要无依据要求用户重装 Agent。

## 计划文档

用户要求的设计或实施计划可以保存在当前工作区，供后续审阅和执行；除非用户明确要求，不得自动提交、推送或以其他方式上传计划文档。
