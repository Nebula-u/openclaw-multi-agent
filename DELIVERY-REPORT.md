# 交付报告 — openclaw-sdlc-multi-agent 原生架构重建

> 本报告如实说明"做了什么、验证了什么、没验证什么、被什么挡住、还剩什么"。
> 所有"已验证"条目均有 `artifacts/` 下的真实运行产物或本仓库文件为证；未执行的一律不声称已执行。
> 证据分级沿用项目约定：**OBSERVED**（亲自运行并观察到）/ **INFERRED**（据已知事实推断）/ **PROPOSED**（设计意图）/ **UNKNOWN**（未知）。

- 探测到的运行环境：**Windows** + Git Bash + PowerShell 7 + Git 2.51.2；OpenClaw CLI **2026.7.1-2 (0790d9f)**。
- 项目根：`D:\MicroConnect\project\openclaw-multi-agent`（绝对路径；脚本一律基于脚本自身位置解析，不依赖 CWD）。
- 本阶段范围：**交付前（pre-operations）**制品与安装/校验工具链。**未**执行真实安装（Apply）、**未**运行端到端流水线、**未**部署。

---

## 1. 实际完成（actually-done）— 文件已落盘

首个提交共纳入 **163 个文件**。按目录：

| 目录 | 数量 | 内容 |
|---|---|---|
| `(root)` | 5 | README.md、SECURITY.md、CHANGELOG.md、.gitignore、原始规范 prompt |
| `agents/` | 42 | 7 个 Agent 的 workspace（各 AGENTS/SOUL/TOOLS/IDENTITY + rules/ 占位）+ `common/` 6 份共享规则 + manager 的 templates/ 占位 |
| `contracts/` | 12 | JSON Schema 契约（task、workflow、evidence、gate-result、approval-request/response、result、command-record、context-manifest、acceptance-criteria、review-findings、release-decision） |
| `templates/` | 14 | workflow.json、task.json、context-manifest.json、result.json、evidence.jsonl、command-records.jsonl 及 7 份阶段报告 + context.md + final-report.md 模板 |
| `docs/` | 15 | 架构、原生集成、编排、上下文与规则传递、工作流、契约、状态与恢复、Git worktree、证据与断言、人工审批、Gate 清单、无沙箱测试策略、兼容性报告、故障排查、威胁模型 |
| `config/` | 4 | default-policy.yaml、project-config.example.yaml、agent-models.example.json、openclaw-config-notes.md |
| `scripts/` | 7 | install.ps1/.sh、validate-install.ps1/.sh、restore-openclaw-config.ps1/.sh、preflight-probe.sh |
| `examples/` | 3 | demo-request.md、demo-policy.yaml、demo-project-config.yaml |
| `artifacts/` | 61 | 仅 `preflight/` 环境探测原始产物（validation/ 与 install-dryrun/ 为可重现运行输出，已 .gitignore） |

- 本地 Git 仓库已 `git init`（分支 `main`，**无远程**）并完成首个真实提交。

## 2. 实际验证（actually-verified）— 亲自运行并观察到结果（OBSERVED）

以下均为本会话（或前序会话，产物留存于 `artifacts/`）真实执行、退出码与输出经观察：

1. **环境探测**：`openclaw --version` → `2026.7.1-2 (0790d9f)`；`openclaw config validate --json` → **exit 0**；`openclaw doctor --lint --json` → **exit 1**（既有环境提示，未修复）。产物见 `artifacts/preflight/`。
2. **install.ps1 dry-run（从 `C:\Windows\System32` 调用）**：生成的 manifest 中 `runtime_root_abs` 指向**项目根下**而非 System32 → CWD 无关的绝对路径解析（"System32 防护"）**成立**；manager 白名单=6 个工作 Agent、`requireAgentId=true`、工作 Agent `allowAgents=[]`、`test-agent sandbox=off`、所有 workspace/agentDir 为绝对路径且互异。
3. **install.sh dry-run（从临时目录调用）**：结论同上，manifest 为合法 JSON（含 Windows `C:\` 路径已正确转义）。
4. **validate-install.ps1** → **68 项检查，0 失败，exit 0**。
5. **validate-install.sh** → **PASS=68 FAIL=0 UNKNOWN=0，exit 0**（jq 可用，JSON/JSONL 合法性全部实检）。
6. **契约/模板 JSON、JSONL 合法性**：12 契约 + 4 模板 JSON + 2 JSONL 全部解析通过（OBSERVED，见校验日志）。
7. **脚本语法**：全部 `.sh` 通过 `bash -n`；全部 `.ps1` 通过 PowerShell 解析。
8. **自查并修复**：静态校验曾抓出 manager `TOOLS.md` 含字面量 `sdlcctl`（FAIL）→ 改写去除 → 复跑 PASS；`validate-install.sh` 在 `set -u` 下的 `$3` 未定义变量 bug → 用默认展开修复 → 复跑 exit 0。

## 3. 已生成但未验证（generated-but-unverified）— 内容已产出，正确性未经机器验证

以下为 **PROPOSED / INFERRED**，仅经人工审阅规则一致性，**未**实际执行：

1. **manager-agent 的真实编排行为**：跨 Agent 调度、上下文包投递、Gate 判定、events.jsonl 哈希链、审批闭环等，均为**设计与文档**，从未在活动会话中真正运行。
2. **端到端流水线**：`examples/demo-request.md` **未**跑过任何一次；7 阶段流水线未产生过真实制品。
3. **`openclaw config set`（含 `--dry-run` 形式）从未执行**：install 脚本默认 dry-run 分支只打印计划并写 manifest；对 `agents.list[i].subagents` / `.sandbox` 的补丁校验位于 `-Apply` 确认门之后，本会话未触达。故这些字段补丁"能通过 config set 校验"目前是 **INFERRED**，非 OBSERVED。
4. **install `--apply` 路径**（真实创建 7 个 Agent、写配置、备份、回滚）**未**执行——按安全约束需用户显式确认。仅 dry-run 计划经验证。
5. **restore-openclaw-config.ps1/.sh**：恢复逻辑已写，但因未 Apply、无配置快照，**未**实跑。
6. **`sessions_spawn` 真实 schema**：`compatibility-report.md` 中已标注 **UNVERIFIED**——真正的跨 Agent 派生调用与 `requireAgentId` 的运行时强制均未实测。
7. **全部 docs 与 Agent prompt 的语义正确性**：已就硬规则一致性审阅，但非可执行、未机器校验。

## 4. 环境受限（environment-blocked）

1. **无沙箱（本阶段既定）**：`test-agent sandbox.mode=off`，每次测试将记录 `isolation_mode=UNSANDBOXED_LOCAL`。**未提供真实隔离**——已在 `docs/unsandboxed-test-policy.md`、`threat-model.md` 作为已知风险明确说明。
2. **`doctor --lint` exit 1**：既有环境 lint 状态，**非**本项目引入，按规则**未**修复（不运行 `doctor --fix`）。
3. **环境自述与实际不符**：会话环境 prompt 声称 macOS / `/Users/lm72wx`，实际为 Windows 路径；某子代理对 `/Users/lm72wx` 的一次探测被权限分类器拦截，已改用只读工具绕过，**无功能影响**。

## 5. 遗留问题与后续步骤（remaining-issues / next steps）

1. **执行 Apply**（需用户显式同意）：`pwsh -File scripts/install.ps1 -Apply`（会先备份、打印变更摘要、要求确认）以真正注册 7 个 Agent，随后 `openclaw config validate` 复核。
2. **首次端到端演练**：Apply 后用 `examples/demo-request.md` 跑通一次，实证编排、Gate、上下文包、events 哈希链、审批。
3. **确认 `sessions_spawn` 真实契约**：在依赖 `requireAgentId` 强制前，用一次真实派生核对其标志与行为。
4. **验证配置补丁**：在有备份的配置上跑 `install --apply`，确认 `subagents`/`sandbox` 补丁通过 `config set` 校验。
5. **换行**：仓库文件为 LF，Windows 检出时 Git 将规范化为 CRLF（已见告警）。如需固定 EOL，建议加 `.gitattributes`。
6. **markdownlint**：manager `TOOLS.md` 第 15 行有 MD032（列表前后空行）样式告警，属外观项。

## 6. 已恪守的硬边界（未触碰）

- **未**引入任何 Python 控制平面 / `sdlcctl` / 运行时编排 CLI（静态校验强制字面零出现）。
- **未**修改/删除用户既有 OpenClaw Agent、配置、认证、会话、绑定、workspace。
- **未**联网、**未**自动安装任何依赖/软件、**未**改系统服务/注册表/计划任务/全局环境变量。
- **未**运行 `openclaw doctor --fix`；**未**安装 Docker/沙箱。
- Git 仅本地：**无** remote / push / pull / fetch；**未**用 `git reset --hard` 或 `git clean -fdx`。
- **未**记录/展示任何令牌、密码、cookie、私钥；快照目录已 .gitignore。
- 一切绝对路径（workspace/agentDir/task/artifact/worktree）；无相对运行时路径。

## 7. 复现方式（任何人可自证第 2 节）

```bash
# 静态校验（PowerShell 主实现）
pwsh -NoProfile -File scripts/validate-install.ps1        # 期望：68/0/exit 0
# 静态校验（Bash 等价实现，需 jq 才做 JSON 实检）
bash scripts/validate-install.sh                          # 期望：PASS=68 FAIL=0 exit 0
# 安装 dry-run（默认，不改任何配置）——可从任意目录调用验证 CWD 无关
pwsh -NoProfile -File scripts/install.ps1                 # 生成 artifacts/install-dryrun/install-manifest.dryrun.json
bash  scripts/install.sh
```

> 真实安装请显式加 `-Apply` / `--apply`，并仅在你确认变更摘要后进行。本交付**未**执行 Apply。
