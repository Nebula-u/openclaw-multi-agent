# Monitor 会话稳定渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 Monitor 会话区在刷新时的闪烁与自动跳转，同时保留新内容提醒。

**Architecture:** 前端按会话缓存消息指纹、内容与滚动位置。刷新时只在会话内容变化后追加新节点；发生非追加变化才重建，并恢复原滚动位置。切换标签时立即渲染目标会话缓存，再异步校验更新。

**Tech Stack:** 原生浏览器 JavaScript、现有 Monitor 静态页面。

## Global Constraints

- 仅修改 Monitor 前端，不改后端 API 或 Agent runtime。
- 不新增自动化测试；由用户手动验收。
- 不自动滚动会话窗口。

---

### Task 1: 稳定会话渲染

**Files:**
- Modify: `monitor/ui/app.js`

**Interfaces:**
- Consumes: `GET /api/agents/:agentId/sessions/:sessionId/messages` 返回的 `messages[]`。
- Produces: 会话消息的增量 DOM 更新和可点击的新消息状态。

- [ ] 保存每个会话的消息指纹与 DOM 状态。
- [ ] 无内容变化时保留现有 DOM；新增内容时只追加消息节点。
- [ ] 非追加变化时恢复旧的滚动位置，不执行自动滚动。
- [ ] 自动追加新消息，且始终保持当前滚动位置。
- [ ] 用请求序号忽略过期响应，避免快速切换会话时错写内容。

### Task 2: 手动验收

**Files:**
- Modify: `monitor/ui/app.js`

- [ ] 在会话历史中滚动停留，等待无内容的 workflow 刷新，确认视图不闪烁且位置不变。
- [ ] 产生新消息，确认会话自动更新且不跳至末尾。
- [ ] 快速切换不同 Agent 标签，确认不会显示错误会话内容。
