# Unsafe legacy direct-write scripts

这些脚本来自早期 Demo，只保留用于取证审计。它们会直接覆盖 `runtime/control` 下的 workflow、task 或 active index，绕过 Runtime Guard、CAS 和事务日志，因此已改为 `.disabled`，不得在任何活动 workflow 中执行。

若需要提取其中的数据转换逻辑，必须把逻辑重写为版本化迁移器，输入使用只读副本，输出写入新的迁移目录，并由 Control Kernel 生成审计记录。禁止恢复原扩展名后直接运行。

