# rules/README.md — review-agent 本地规则副本

> 版本: review-agent-rules-readme v1

## 本目录是什么

本目录（`agents/review-agent/workspace/rules/`）存放 6 份**通用规则的本地副本**。安装脚本会在部署 review-agent 时，把 `agents/common/` 下的 6 份规则**复制**到本目录：

- `COMMON_RULES.md`
- `CONTEXT_PROTOCOL.md`
- `EVIDENCE_RULES.md`
- `GIT_RULES.md`
- `APPROVAL_RULES.md`
- `SECURITY_RULES.md`

## 为什么要有本地副本

- `AGENTS.md` 第 2 节要求本 Agent 显式加载并遵守这 6 份规则；本地副本保证运行期不依赖 `agents/common/` 的相对路径，也不需要联网或跨 workspace 读取。
- 这些副本属于本 Agent workspace 的**永久规则**，优先级见 `COMMON_RULES.md` 第 0 节（第 2 类）。

## 使用与维护规则

- 副本内容以安装时固化的版本为准；本 Agent **只读**这些文件，不在运行期修改它们。
- 若 `agents/common/` 下的源规则更新，需由安装/更新流程重新复制到本目录，并在对应 workflow 的 `rules-snapshot.md` 中记录版本与哈希；本 Agent 不自行拉取或改写。
- 运行期规则冲突时，按 `COMMON_RULES.md` 第 0 节优先级判定。
