# ADR 索引

本目录记录 Control Kernel + PostgreSQL 重构中不可回退的关键决策。每条 ADR 说明背景、备选方案、决定与后果，供后续接手者判断「这里看起来可以简化」时先对照。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](./0001-control-kernel-language.md) | Control Kernel 用 JavaScript 而非 Python | 已接受 |
| [0002](./0002-dual-schema-postgres.md) | 单库双 schema：kernel 存事实，langgraph 存决策 | 已接受 |
| [0003](./0003-lease-arbitration.md) | 并发闸门用 PostgreSQL 部分唯一索引做 lease 仲裁 | 已接受 |
| [0004](./0004-monitor-degradation.md) | Monitor 在 Kernel 不可达时降级为 checkpoint 只读 | 已接受 |

约定：ADR 一旦「已接受」就不再修改正文；若决策被推翻，新增一条 ADR 并把旧条状态改为「已取代」，注明取代者编号。
