# ADR：宿主机原生 Supervisor Core 与静态 HTML Dashboard

状态：Accepted for implementation  
日期：2026-08-06

## 决策

可观测性和监督能力由宿主机原生 Node.js Supervisor Core 提供。它可以常驻，但不是第二个
编排器：不直接 spawn 工作 Agent，不决定 workflow/task 状态，不写 completion receipt，
不绕过 Gate、审批或 Runtime Guard。

Dashboard 使用可直接打开的原生 HTML、CSS 和 JavaScript。页面关闭、未打开或浏览器退出时，
Supervisor Core、Watchdog、监督请求和 manager 唤醒继续运行。

## 权威边界

- `<runtime>/control/control.db` 是 workflow、task、run、dispatch 和 supervision 的唯一控制
  状态权威。
- `<runtime>/monitor/monitor.db` 只保存可重建遥测、cursor、活动和健康投影。
- Dashboard 只读取经过脱敏的 HTTP/SSE 数据；人工操作只创建监督请求。
- Watchdog 只创建 durable supervision request，不直接联系工作 Agent。
- Wake Adapter 只唤醒 `manager-agent`；manager 在 audit 和原 session 核查后执行 NUDGE、
  reconciliation、retry review 或人工升级。

## 运行方式

- Supervisor Core：宿主机 `node monitor/supervisor.mjs`。
- Dashboard：直接打开 `monitor/ui/index.html`。
- API：默认只监听 `127.0.0.1`。
- `file://` 页面访问 API 时只允许 loopback、受限 Origin 和本地短期 token。

## 故障语义

- Supervisor Core 停止不影响原 workflow，只失去观察和自动监督。
- Dashboard 停止只影响显示。
- `monitor.db` 损坏时删除后重建，不能反向修复 `control.db`。
- Control Kernel audit 失败时所有监督动作失败关闭。
- lease 过期只触发核查，不直接写 LOST 或重复 spawn。

## 实施依赖

只读 Monitor、activity、静态 Dashboard 和 Watchdog shadow 可以先实施。自动 NUDGE 和
manager 唤醒进入生产模式前，必须完成 Manager 编排加固计划第 1～4 轮；受控 retry 前必须
完成第 5～7 轮并验证真实 OpenClaw session 接口。

