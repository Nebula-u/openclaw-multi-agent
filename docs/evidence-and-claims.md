# Evidence、CommandRecord 与 Claims

## Evidence

`evidence.jsonl` 每行遵循 `contracts/evidence.schema.json`。存在 `locator_abs` 时，路径必须位于授权 worktree 或本 run artifact；文件必须普通、非 symlink。声明 `sha256` 时，本地代码按原始字节重新计算。

Git 证据可使用 `git_locator`，但 candidate 推进仍以本地 Git 对象、ancestry 和 HEAD 校验为准。

## CommandRecord

`command-records.jsonl` 每行记录 executable/argv、cwd、时间、exit code、timeout、stdout/stderr locator、attempt、Agent、task、run 和 isolation mode。

stdout/stderr 必须独立落盘。声明摘要时，必须与文件字节 SHA 一致。TEST 的 isolation mode 必须为 `SANDBOXED_DOCKER`。

## Claims

Agent 声明分为：

- `OBSERVED`：有当前 run 的 evidence/command/git 证据；
- `INFERRED`：基于观察推断，必须说明限制；
- `PROPOSED`：建议或计划；
- `UNKNOWN`：证据不足。

只有 `OBSERVED` 可以直接陈述为已发生事实。Agent 自报“测试通过”“可发布”不构成 Gate PASS。

## 接收 receipt

ingestion receipt 记录 raw/cleaned SHA、清洗变换、最终 output 和所有 report/CommandRecord/evidence 引用的 SHA。receipt 是接收证据；workflow 是否推进仍由 local Gate 和 checkpoint 决定。

## 事件链

checkpoint 事件对 canonical JSON 使用 SHA-256；文件证据直接哈希原始字节。两者用途不同，不得把对象 canonical hash 当作文件摘要。
