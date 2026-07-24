# manager-agent / rules

安装脚本会在此目录放置 6 份**共享规则的本地权威副本**，供 manager-agent 在运行时加载（不依赖相对路径跳出 workspace 读取）：

- `COMMON_RULES.md`
- `CONTEXT_PROTOCOL.md`
- `EVIDENCE_RULES.md`
- `GIT_RULES.md`
- `APPROVAL_RULES.md`
- `SECURITY_RULES.md`

源文件位于项目 `agents/common/`。安装（`install.ps1` / `install.sh`）执行 Apply 时，会把这 6 份复制到本目录以及每个 Agent 的 `rules/`。此处的副本一旦安装即视为该 Agent 的权威规则来源之一（优先级见 `COMMON_RULES.md` 第 0 节）。

> 若本目录尚未包含上述文件，说明尚未执行 Apply 安装；dry-run 不复制规则文件。
