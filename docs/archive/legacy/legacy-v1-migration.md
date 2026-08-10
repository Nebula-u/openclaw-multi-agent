# Legacy v1 forensic quarantine

`scripts/migrate-legacy-v1.mjs` 将不一致的文件型 v1 workflow 保存为取证证据，并在 v2 Control Kernel 中创建全新的隔离 tombstone。它不是状态修复器，也不把旧 snapshot 当作可继续运行的当前状态。

## 不变量

- `plan` 只读：计算 control/artifact 文件清单和 SHA-256 tree digest，检查旧事件哈希链、snapshot revision 与 active index。
- `apply` 复制 control tree、artifact tree 和原 active index，复制后重新计算 tree digest；源目录不写入、不删除、不重命名。
- archive 中每个 workflow 的 `forensic-report.json` 和证据副本设为只读；`manifest.json` 固定本次 migration 的完整范围。
- v2 只得到两条明确标记为 migration 的新事件：创建 tombstone、终结为 `QUARANTINED`。它们不声称是旧事件的续写。
- 旧 candidate commit 仅保存为 `UNTRUSTED_OBSERVATION_ONLY`；v2 `current_candidate_commit` 始终为 `null`。
- 相同 `migration_id` 可安全重放；任何源/archive/report 内容冲突都会失败关闭。

## 命令

先 dry-run：

```powershell
node scripts/migrate-legacy-v1.mjs plan `
  --project-root <project-root-abs> `
  --runtime-root <runtime-root-abs> `
  --migration-id MIG-<id> `
  --workflow-ids WF-<id>,WF-<id>
```

确认报告后 apply：

```powershell
node scripts/migrate-legacy-v1.mjs apply `
  --project-root <project-root-abs> `
  --runtime-root <runtime-root-abs> `
  --db <runtime-root-abs>\control\control.db `
  --migration-id MIG-<id> `
  --workflow-ids WF-<id>,WF-<id>
```

apply 最后生成 v2 投影。随后应运行 `control-kernel.mjs audit --projections true`，确认数据库、事件链与投影一致，且隔离 tombstone 不出现在 active view。

## 2026-08-05 本机迁移

`MIG-legacy-quarantine-20260805` 已对 4 个旧 workflow 执行。`WF-a899188b...` 的 13 条现存事件内部哈希链有效，但与 snapshot revision 18、active index revision 7 均不一致；报告分别记录，不补造缺失的 5 条事件。4 个 v2 tombstone 均为 revision 2 / `QUARANTINED` / candidate `null`，最终 v2 audit 为 `CONSISTENT`，active view 为空。
