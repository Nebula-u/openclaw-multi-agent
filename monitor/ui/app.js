(() => {
  'use strict';

  const sameOrigin = window.location.protocol !== 'file:';
  const defaultApi = window.MONITOR_CONFIG?.apiUrl || (sameOrigin ? window.location.origin : 'http://127.0.0.1:4319');
  const state = { apiUrl: defaultApi.replace(/\/$/u, ''), workflows: [], snapshot: null, selectedWorkflowId: localStorage.getItem('openclaw.monitor.workflow') || null, selectedSessionKey: localStorage.getItem('openclaw.monitor.session') || null, source: null, renderedSessionKey: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<'"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const selected = () => state.workflows.find((item) => item.workflow_id === state.selectedWorkflowId) || null;
  const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
  const request = async (path) => { const response = await fetch(`${state.apiUrl}${path}`); const body = await response.json(); if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`); return body; };
  function setConnection(online, label) { $('connection-dot').classList.toggle('online', online); $('connection-state').textContent = label; }
  function taskClass(task) { return String(task.status || 'unknown').toLowerCase(); }
  function renderWorkflows() {
    $('workflow-count').textContent = state.workflows.filter((item) => item.state !== 'TERMINAL').length;
    const root = $('workflow-list');
    if (!state.workflows.length) { root.innerHTML = '<p class="empty-note">尚未发现工作流</p>'; return; }
    root.innerHTML = state.workflows.map((workflow) => `<button class="workflow-item ${workflow.workflow_id === state.selectedWorkflowId ? 'active' : ''}" type="button" data-workflow="${escapeHtml(workflow.workflow_id)}"><span><i class="dot ${escapeHtml(String(workflow.state).toLowerCase())}"></i>${escapeHtml(workflow.state)}</span><strong>${escapeHtml(workflow.title || workflow.workflow_id)}</strong><small>${escapeHtml(workflow.workflow_id)} · ${escapeHtml(workflow.route_plan?.steps?.length ?? 0)} STEPS</small></button>`).join('');
    root.querySelectorAll('[data-workflow]').forEach((button) => button.addEventListener('click', () => { state.selectedWorkflowId = button.dataset.workflow; localStorage.setItem('openclaw.monitor.workflow', state.selectedWorkflowId); render(); }));
  }
  function renderTaskList(workflow) {
    const root = $('task-list'); const tasks = workflow?.tasks || [];
    if (!tasks.length) { root.innerHTML = '<p class="empty-note">暂无任务</p>'; return; }
    root.innerHTML = tasks.map((task) => `<article class="task-item ${taskClass(task)}"><i></i><div><small>${escapeHtml(task.task_type || task.step_id)}</small><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.assigned_agent)} · TRY ${escapeHtml(task.attempt)}</span></div><b>${escapeHtml(task.status)}</b></article>`).join('');
  }
  function activeSessions(workflow) {
    const tasks = workflow?.tasks || []; const list = [];
    if (workflow?.manager_session_id) list.push({ agent_id: 'manager-agent', session_id: workflow.manager_session_id, label: 'Manager' });
    for (const task of tasks) if (task.session_id) list.push({ agent_id: task.assigned_agent, session_id: task.session_id, label: task.assigned_agent });
    if (!workflow) for (const session of state.snapshot?.global_sessions || []) list.push({ agent_id: session.agent_id, session_id: session.session_id, label: `${session.agent_id} · UNBOUND` });
    return [...new Map(list.map((item) => [`${item.agent_id}:${item.session_id}`, item])).values()];
  }
  async function renderSession(workflow) {
    const sessions = activeSessions(workflow); const tabs = $('agent-tabs');
    if (!sessions.length) { tabs.innerHTML = ''; $('session-meta').textContent = workflow ? '当前 workflow 尚未记录 Agent session。' : '暂无未绑定到 workflow 的 Agent session。'; $('session-window').innerHTML = '<p class="empty-note">没有可显示的会话文本</p>'; return; }
    if (!sessions.some((item) => `${item.agent_id}:${item.session_id}` === state.selectedSessionKey)) state.selectedSessionKey = `${sessions[0].agent_id}:${sessions[0].session_id}`;
    tabs.innerHTML = sessions.map((item) => { const key = `${item.agent_id}:${item.session_id}`; return `<button type="button" role="tab" aria-selected="${key === state.selectedSessionKey}" class="agent-tab ${key === state.selectedSessionKey ? 'active' : ''}" data-session-key="${escapeHtml(key)}">${escapeHtml(item.label)}</button>`; }).join('');
    tabs.querySelectorAll('[data-session-key]').forEach((button) => button.addEventListener('click', () => { state.selectedSessionKey = button.dataset.sessionKey; localStorage.setItem('openclaw.monitor.session', state.selectedSessionKey); state.renderedSessionKey = null; void renderSession(workflow); }));
    const current = sessions.find((item) => `${item.agent_id}:${item.session_id}` === state.selectedSessionKey) || sessions[0]; const key = `${current.agent_id}:${current.session_id}`;
    $('session-meta').textContent = `${current.agent_id} · ${current.session_id}`;
    if (state.renderedSessionKey === key) return; state.renderedSessionKey = key; $('session-window').innerHTML = '<p class="empty-note">正在读取会话...</p>';
    try {
      const response = await request(`/api/agents/${encodeURIComponent(current.agent_id)}/sessions/${encodeURIComponent(current.session_id)}/messages?limit=300`);
      const messages = response.messages || [];
      $('session-window').innerHTML = messages.length ? messages.map((message) => `<article class="session-message ${escapeHtml(message.role)}"><header><span>${message.role === 'assistant' ? escapeHtml(current.agent_id) : 'USER'}</span><time>${escapeHtml(time(message.timestamp))}</time></header><p>${escapeHtml(message.text)}</p></article>`).join('') : '<p class="empty-note">会话中暂无可显示的 user/assistant 文本</p>';
      $('session-window').scrollTop = $('session-window').scrollHeight;
    } catch (error) { $('session-window').innerHTML = `<p class="empty-note">无法读取会话：${escapeHtml(error.message)}</p>`; }
  }
  function renderNotices(workflow) {
    const notices = (state.snapshot?.notifications || []).filter((item) => item.runId === workflow?.run_id).slice(0, 8); const root = $('notification-list');
    root.innerHTML = notices.length ? notices.map((item) => `<article class="notice ${escapeHtml(String(item.status).toLowerCase())}"><b>${escapeHtml(item.status)}</b><span>${escapeHtml(item.type)}</span><small>${escapeHtml(time(item.createdAt))}</small></article>`).join('') : '<p class="empty-note">没有待转达信息</p>';
    const approval = workflow?.pending_approval; $('approval-view').textContent = approval ? `${approval.summary || approval.trigger || '等待 Manager 在原生对话中收集用户决定'}` : '没有待审批事项';
  }
  function renderHr(workflow) {
    const alerts = (state.snapshot?.hr_alerts || []).filter((item) => !workflow || item.workflow_id === workflow.workflow_id || item.workflowId === workflow.workflow_id); $('alert-count').textContent = alerts.length;
    $('alert-list').innerHTML = alerts.length ? alerts.slice(-6).reverse().map((alert) => `<article class="alert"><b>${escapeHtml(alert.agent_id || 'Agent')}</b><span>${escapeHtml((alert.matches || []).map((item) => item.keyword).join(' · '))}</span><p>${escapeHtml((alert.matches || [])[0]?.context || alert.text || '')}</p></article>`).join('') : '<p class="empty-note">暂无即时预警</p>';
    const jobs = (state.snapshot?.hr_jobs || []).filter((job) => job.runId === workflow?.run_id); const reviews = jobs.filter((job) => job.kind === 'SESSION_REVIEW' || job.kind === 'TASK_REVIEW'); const reports = jobs.filter((job) => job.kind === 'DAILY_REVIEW'); const outputByJob = new Map((state.snapshot?.hr_outputs || []).map((output) => [output.job_id, output]));
    const row = (job) => { const output = outputByJob.get(job.jobId); const findings = output?.report?.findings || []; const summary = findings.map((finding) => `${finding.severity} ${finding.category}: ${finding.explanation}`).join('\n'); return `<article class="review"><b>${escapeHtml(job.status)}</b><span>${escapeHtml(job.sourceAgentId || 'HR')}</span><small>${escapeHtml(job.jobId)}</small>${summary ? `<p class="review-text">${escapeHtml(summary)}</p>` : ''}</article>`; };
    $('hr-review-list').innerHTML = reviews.length ? reviews.map(row).join('') : '<p class="empty-note">暂无 HR 复核</p>';
    $('daily-report-list').innerHTML = reports.length ? reports.map(row).join('') : '<p class="empty-note">任务结束后将显示日报</p>';
  }
  function renderSnapshots(workflow) {
    const values = (state.snapshot?.snapshots || []).filter((item) => item.runId === workflow?.run_id).slice(0, 12);
    $('snapshot-list').innerHTML = values.length ? values.map((item) => `<article class="review" title="只读查看；恢复请使用 snapshot-restore，撤销请使用 snapshot-revert"><b>${escapeHtml(item.snapshotKind)}</b><span>${escapeHtml(item.agentId)}</span><small>${escapeHtml(item.sessionId || 'NO SESSION')} · ${escapeHtml(String(item.outputCommit || '').slice(0, 12))}</small><p class="review-text">+${escapeHtml(item.changeSummary?.added?.length || 0)} ~${escapeHtml(item.changeSummary?.modified?.length || 0)} -${escapeHtml(item.changeSummary?.deleted?.length || 0)}</p></article>`).join('') : '<p class="empty-note">暂无代码快照</p>';
  }
  function render() {
    const workflow = selected(); renderWorkflows(); $('workflow-title').textContent = workflow?.title || '等待工作流'; $('workflow-summary').textContent = workflow?.status_reason || workflow?.route_plan?.summary || '选择工作流以查看任务、会话和审查记录。'; $('workflow-state').textContent = workflow?.state || 'UNKNOWN'; $('workflow-state').className = `state-pill ${String(workflow?.state || 'unknown').toLowerCase()}`; $('workflow-step').textContent = workflow ? `STEP ${(workflow.current_step_index ?? 0) + 1}/${workflow.route_plan?.steps?.length ?? 0}` : 'STEP --'; renderTaskList(workflow); renderNotices(workflow); renderSnapshots(workflow); renderHr(workflow); void renderSession(workflow);
  }
  function applySnapshot(snapshot) { state.snapshot = snapshot; state.workflows = snapshot.workflows || []; if (!state.workflows.some((item) => item.workflow_id === state.selectedWorkflowId)) state.selectedWorkflowId = state.workflows[0]?.workflow_id || null; state.renderedSessionKey = null; render(); $('sync-state').textContent = time(snapshot.generated_at); setConnection(true, snapshot.kernel_reachable ? 'KERNEL CONNECTED' : 'KERNEL DEGRADED'); }
  function stream() {
    if (state.source) state.source.close(); const source = new EventSource(`${state.apiUrl}/api/workflows/stream`); state.source = source;
    source.addEventListener('snapshot', (event) => { const value = JSON.parse(event.data).payload; if (value) applySnapshot(value); });
    source.addEventListener('activity', () => { state.renderedSessionKey = null; void renderSession(selected()); }); source.addEventListener('hr-alert', () => { void reload(); }); source.onerror = () => setConnection(false, 'RECONNECTING');
  }
  async function reload() { try { const result = await request('/api/workflows'); applySnapshot(result); stream(); } catch (error) { setConnection(false, `OFFLINE: ${error.message}`); } }
  window.addEventListener('beforeunload', () => state.source?.close()); void reload();
})();
