# ADR 索引

本目录记录当前及历史架构决策。读取旧 ADR 时必须先看状态；“已取代”只用于解释历史，不是当前实施依据。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](./0001-control-kernel-language.md) | 旧 Control Kernel 语言与同进程边界 | 已由 0005 取代 |
| [0002](./0002-dual-schema-postgres.md) | 旧双 schema 数据库设计 | 已由 0005 取代 |
| [0003](./0003-lease-arbitration.md) | 旧数据库 lease 仲裁设计 | 已由 0005 取代 |
| [0004](./0004-monitor-degradation.md) | 旧双源 Monitor 降级设计 | 已由 0005 取代 |
| [0005](./0005-single-machine-sqlite.md) | 单机 SQLite Control Kernel | 已接受 |
| [0006](./0006-git-snapshot-index.md) | Git 保存代码快照，SQLite 只存索引 | 已接受 |

约定：新决定取代旧决定时，新增 ADR 并在索引及旧 ADR 顶部明确指向取代者；旧正文保留为历史解释。
