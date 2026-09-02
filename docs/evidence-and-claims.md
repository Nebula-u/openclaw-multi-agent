# Evidence、Artifact 与 Claims

## Artifact 索引

`runtime/artifacts/<workflow>/<task>/` 保存 result、context、日志、receipt 和可选证据文件。SQLite `artifacts` 表只记录 URI、SHA-256、大小、类型和 commit 关联，不保存内容寻址副本。

Agent 输出中的绝对引用只能位于授权 artifact root 或 worktree，且必须是普通非 symlink 文件。Orchestrator 对发布的 result/receipt 重新计算 SHA-256 后登记。

## Git 证据

代码修改以宿主 Git 为准。snapshot 保存 input/output commit 与宿主生成的 name-status/stat；patch 按需从目标仓库计算。Session 中声称“修改了某文件”不能替代 Git diff。

## Claims

- `OBSERVED`：有当前运行的文件、命令或 Git 证据；
- `INFERRED`：根据观察推断，必须说明限制；
- `PROPOSED`：建议或计划；
- `UNKNOWN`：证据不足。

只有 `OBSERVED` 可直接陈述为已发生事实。Agent 自报测试通过或可发布仍需对应输出、exit code 或 Git 证据。

本版本没有 workflow 事件哈希链。文件 SHA 用于验证具体 artifact 字节，Git commit 用于验证代码历史；二者不承担事件重放或数据库防篡改证明。
