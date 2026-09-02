(() => {
  'use strict';

  const sameOrigin = window.location.protocol !== 'file:';
  const defaultApi = window.MONITOR_CONFIG?.apiUrl || (sameOrigin ? window.location.origin : 'http://127.0.0.1:4319');
  const state = { apiUrl: defaultApi.replace(/\/$/u, ''), workflows: [], snapshot: null, selectedWorkflowId: localStorage.getItem('openclaw.monitor.workflow') || null, selectedSessionKey: localStorage.getItem('openclaw.monitor.session') || null, source: null, sessionCache: new Map(), dirtySessionKeys: new Set(), visibleSessionKey: null, sessionRequestVersion: 0, sessionLoadingKey: null, queuedApprovals: new Map(), queuedControls: new Map(), openApprovalDetails: new Set() };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<'"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const selected = () => state.workflows.find((item) => item.workflow_id === state.selectedWorkflowId) || null;
  const time = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
  const request = async (path) => { const response = await fetch(`${state.apiUrl}${path}`); const body = await response.json(); if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`); return body; };
  const post = async (path, value) => { const response = await fetch(`${state.apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); const body = await response.json(); if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`); return body; };
  const sessionKey = (session) => `${session.agent_id}:${session.session_id}`;
  const messageFingerprint = (message) => JSON.stringify([message.role ?? '', message.timestamp ?? '', message.text ?? '']);
  const messageHtml = (message, agentId) => `<article class="session-message ${escapeHtml(message.role)}"><header><span>${message.role === 'assistant' ? escapeHtml(agentId) : 'USER'}</span><time>${escapeHtml(time(message.timestamp))}</time></header><p>${escapeHtml(message.text)}</p></article>`;
  function setConnection(online, label) { $('connection-dot').classList.toggle('online', online); $('connection-state').textContent = label; }
  function renderCachedSession(key, agentId) {
    const cached = state.sessionCache.get(key); if (!cached) return false;
    const root = $('session-window'); root.innerHTML = cached.messages.length ? cached.messages.map((message) => messageHtml(message, agentId)).join('') : '<p class="empty-note">会话中暂无可显示的 user/assistant 文本</p>';
    root.scrollTop = cached.scrollTop ?? 0; state.visibleSessionKey = key; return true;
  }
  function saveVisibleSessionScroll() {
    if (!state.visibleSessionKey) return;
    const cached = state.sessionCache.get(state.visibleSessionKey); if (cached) cached.scrollTop = $('session-window').scrollTop;
  }
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
    if (!sessions.length) { state.sessionRequestVersion += 1; state.sessionLoadingKey = null; tabs.innerHTML = ''; $('session-meta').textContent = workflow ? '当前 workflow 尚未记录 Agent session。' : '暂无未绑定到 workflow 的 Agent session。'; $('session-window').innerHTML = '<p class="empty-note">没有可显示的会话文本</p>'; $('session-status').textContent = '等待 session'; return; }
    if (!sessions.some((item) => sessionKey(item) === state.selectedSessionKey)) state.selectedSessionKey = sessionKey(sessions[0]);
    tabs.innerHTML = sessions.map((item) => { const key = sessionKey(item); return `<button type="button" role="tab" aria-selected="${key === state.selectedSessionKey}" class="agent-tab ${key === state.selectedSessionKey ? 'active' : ''}" data-session-key="${escapeHtml(key)}">${escapeHtml(item.label)}</button>`; }).join('');
    tabs.querySelectorAll('[data-session-key]').forEach((button) => button.addEventListener('click', () => { saveVisibleSessionScroll(); state.selectedSessionKey = button.dataset.sessionKey; localStorage.setItem('openclaw.monitor.session', state.selectedSessionKey); state.dirtySessionKeys.add(state.selectedSessionKey); void renderSession(workflow); }));
    const current = sessions.find((item) => sessionKey(item) === state.selectedSessionKey) || sessions[0]; const key = sessionKey(current);
    $('session-meta').textContent = `${current.agent_id} · ${current.session_id}`;
    $('session-status').textContent = '自动更新';
    if (state.visibleSessionKey !== key) renderCachedSession(key, current.agent_id);
    if ((state.sessionCache.has(key) && !state.dirtySessionKeys.has(key)) || state.sessionLoadingKey === key) return;
    const requestVersion = ++state.sessionRequestVersion; state.sessionLoadingKey = key;
    if (!state.sessionCache.has(key)) $('session-window').innerHTML = '<p class="empty-note">正在读取会话...</p>';
    try {
      const response = await request(`/api/agents/${encodeURIComponent(current.agent_id)}/sessions/${encodeURIComponent(current.session_id)}/messages?limit=300`);
      const messages = response.messages || [];
      if (requestVersion !== state.sessionRequestVersion || state.selectedSessionKey !== key) return;
      const fingerprints = messages.map(messageFingerprint); const previous = state.sessionCache.get(key); const isAppend = previous && previous.fingerprints.length <= fingerprints.length && previous.fingerprints.every((value, index) => value === fingerprints[index]);
      const root = $('session-window');
      if (!previous) { root.innerHTML = messages.length ? messages.map((message) => messageHtml(message, current.agent_id)).join('') : '<p class="empty-note">会话中暂无可显示的 user/assistant 文本</p>'; state.visibleSessionKey = key; }
      else if (isAppend && fingerprints.length > previous.fingerprints.length) {
        const additions = messages.slice(previous.fingerprints.length); root.insertAdjacentHTML('beforeend', additions.map((message) => messageHtml(message, current.agent_id)).join(''));
      } else if (!isAppend) {
        const scrollTop = root.scrollTop; root.innerHTML = messages.length ? messages.map((message) => messageHtml(message, current.agent_id)).join('') : '<p class="empty-note">会话中暂无可显示的 user/assistant 文本</p>'; root.scrollTop = scrollTop;
      }
      state.sessionCache.set(key, { fingerprints, messages, scrollTop: root.scrollTop }); state.dirtySessionKeys.delete(key);
    } catch (error) { if (requestVersion === state.sessionRequestVersion && state.selectedSessionKey === key && !state.sessionCache.has(key)) $('session-window').innerHTML = `<p class="empty-note">无法读取会话：${escapeHtml(error.message)}</p>`; } finally { if (requestVersion === state.sessionRequestVersion) state.sessionLoadingKey = null; }
  }
  const approvalKey = (workflow, approval) => `${workflow.workflow_id}:${approval.decisionId ?? approval.decision_id}`;
  async function waitForApprovalReceipt(commandId, key, attempts = 0) {
    try {
      const value = await request(`/api/approval-commands/${encodeURIComponent(commandId)}`);
      state.queuedApprovals.set(key, { commandId, status: value.receipt.status });
      const receipt = value.receipt; $('approval-view').innerHTML = `<p>${escapeHtml(receipt.status === 'ACCEPTED' ? '审批已由 Orchestrator 接受。' : `审批被拒绝：${receipt.error?.message || receipt.error?.code || '未知错误'}`)}</p>`;
      void reload();
    } catch (error) {
      if (attempts < 20 && /APPROVAL_COMMAND_RECEIPT_NOT_FOUND|HTTP 404/u.test(error.message)) setTimeout(() => { void waitForApprovalReceipt(commandId, key, attempts + 1); }, 1000);
      else $('approval-view').innerHTML = `<p>审批命令已提交：${escapeHtml(commandId)}。${escapeHtml(error.message)}</p>`;
    }
  }
  async function submitApproval(workflow, approval, choice) {
    const key = approvalKey(workflow, approval); if (state.queuedApprovals.has(key)) return;
    state.queuedApprovals.set(key, { commandId: null, status: 'SUBMITTING' }); render();
    const root = $('approval-view'); root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const result = await post('/api/approvals/resolve', { workflow_id: workflow.workflow_id, run_id: workflow.run_id, task_id: approval.taskId ?? approval.task_id ?? null,
        decision_id: approval.decisionId ?? approval.decision_id, choice, notes: '' });
      state.queuedApprovals.set(key, { commandId: result.command_id, status: 'QUEUED' }); render();
      void waitForApprovalReceipt(result.command_id, key);
    } catch (error) { state.queuedApprovals.delete(key); root.innerHTML = `<p>无法提交审批：${escapeHtml(error.message)}</p>`; }
  }
  const CONFIRM_CHOICES = new Set(['APPROVE', 'ACCEPT', 'CONTINUE', 'RETRY_SAME_AGENT']);
  const REJECT_CHOICES = new Set(['REJECT', 'REJECTED', 'CANCEL', 'ABORT']);
  async function waitForWorkflowControlReceipt(commandId, workflowId, attempts = 0) {
    try {
      const value = await request(`/api/workflow-control-commands/${encodeURIComponent(commandId)}`);
      state.queuedControls.set(workflowId, { commandId, status: value.receipt.status, error: value.receipt.error });
      void reload();
    } catch (error) {
      if (attempts < 20 && /WORKFLOW_CONTROL_COMMAND_RECEIPT_NOT_FOUND|HTTP 404/u.test(error.message)) setTimeout(() => { void waitForWorkflowControlReceipt(commandId, workflowId, attempts + 1); }, 1000);
      else state.queuedControls.set(workflowId, { commandId, status: 'FAILED', error: { message: error.message } });
    }
  }
  async function submitWorkflowControl(workflow, action) {
    if (state.queuedControls.has(workflow.workflow_id)) return;
    state.queuedControls.set(workflow.workflow_id, { status: 'SUBMITTING' }); render();
    try {
      const result = await post('/api/workflows/control', { workflow_id: workflow.workflow_id, run_id: workflow.run_id, action, notes: '' });
      state.queuedControls.set(workflow.workflow_id, { commandId: result.command_id, status: 'QUEUED' }); render();
      void waitForWorkflowControlReceipt(result.command_id, workflow.workflow_id);
    } catch (error) { state.queuedControls.set(workflow.workflow_id, { status: 'FAILED', error: { message: error.message } }); render(); }
  }
  function renderWorkflowControl(workflow) {
    const root = $('workflow-control');
    if (!workflow || !['ACTIVE', 'HOLD'].includes(workflow.state)) { root.innerHTML = ''; return; }
    const action = workflow.state === 'ACTIVE' ? 'PAUSE' : 'RESUME';
    const label = action === 'PAUSE' ? '暂停本轮' : '恢复流程';
    const queued = state.queuedControls.get(workflow.workflow_id);
    if (queued?.status === 'ACCEPTED') { state.queuedControls.delete(workflow.workflow_id); return renderWorkflowControl(workflow); }
    const status = queued
      ? `<small>${escapeHtml(queued.status === 'FAILED' ? `操作失败：${queued.error?.message || '未知错误'}` : queued.commandId ? `命令已提交：${queued.commandId}` : '正在提交流程控制…')}</small>`
      : `<small>${action === 'PAUSE' ? '当前任务会安全完成；后续步骤和重试不会派发。' : '按当前任务状态继续。'}</small>`;
    root.innerHTML = `<button type="button" data-workflow-control="${action}"${queued ? ' disabled' : ''}>${label}</button>${status}`;
    root.querySelector('[data-workflow-control]').addEventListener('click', () => { void submitWorkflowControl(workflow, action); });
  }
  function approvalAction(option, label, tone, queued) {
    if (!option) return `<button type="button" class="approval-action ${tone}" disabled><span>${label}</span><small>当前审批未提供此操作</small></button>`;
    const optionId = option.option_id ?? option.id;
    return `<button type="button" class="approval-action ${tone}" data-approval-choice="${escapeHtml(optionId)}"${queued ? ' disabled' : ''}><span>${label}</span><small>${escapeHtml(option.description || optionId)}</small></button>`;
  }
  function approvalCard(approval, requestValue, options, queued, key) {
    const optionId = (item) => item.option_id ?? item.id;
    const confirm = options.find((item) => CONFIRM_CHOICES.has(optionId(item)));
    const reject = options.find((item) => REJECT_CHOICES.has(optionId(item)));
    const other = options.filter((item) => item !== confirm && item !== reject);
    const decisionId = approval.decisionId ?? approval.decision_id;
    const queueStatus = queued ? `<div class="approval-status" role="status"><i></i><span>${queued.commandId ? `审批命令已提交：${escapeHtml(queued.commandId)}` : '正在安全提交审批…'}</span></div>` : '';
    const otherActions = other.length ? other.map((item) => approvalAction(item, optionId(item) === 'REWORK' ? '返工后重试' : item.description || optionId(item), 'other', queued)).join('') : '<p class="approval-empty">当前审批没有其他可选操作</p>';
    return `<article class="approval-card"><div class="approval-card-head"><span class="approval-kicker">需要你的决定</span><code>${escapeHtml(decisionId)}</code></div><p class="approval-summary">${escapeHtml(requestValue.summary || approval.trigger || '需要人工决定')}</p>${queueStatus}<div class="approval-primary-actions" role="group" aria-label="主要审批操作">${approvalAction(confirm, '确认', 'confirm', queued)}${approvalAction(reject, '拒绝', 'reject', queued)}</div><details class="approval-other-actions"${state.openApprovalDetails.has(key) ? ' open' : ''}><summary>其他</summary><div>${otherActions}</div></details><p class="approval-manager-note">也可在与 Manager 的对话中明确授权，由 Manager 转交相同审批。</p></article>`;
  }
  function renderNotices(workflow) {
    const notices = (state.snapshot?.notifications || []).filter((item) => item.runId === workflow?.run_id).slice(0, 8); const root = $('notification-list');
    root.innerHTML = notices.length ? notices.map((item) => `<article class="notice ${escapeHtml(String(item.status).toLowerCase())}"><b>${escapeHtml(item.status)}</b><span>${escapeHtml(item.type)}</span><small>${escapeHtml(time(item.createdAt))}</small></article>`).join('') : '<p class="empty-note">没有待转达信息</p>';
    const approval = workflow?.pending_approval; const approvalRoot = $('approval-view');
    if (!approval) { for (const key of state.queuedApprovals.keys()) if (key.startsWith(`${workflow?.workflow_id}:`)) state.queuedApprovals.delete(key); for (const key of state.openApprovalDetails) if (key.startsWith(`${workflow?.workflow_id}:`)) state.openApprovalDetails.delete(key); approvalRoot.textContent = '没有待审批事项'; return; }
    const requestValue = approval.request || {}; const options = Array.isArray(requestValue.options) ? requestValue.options : [];
    const key = approvalKey(workflow, approval); const queued = state.queuedApprovals.get(key);
    for (const openKey of state.openApprovalDetails) if (openKey.startsWith(`${workflow.workflow_id}:`) && openKey !== key) state.openApprovalDetails.delete(openKey);
    approvalRoot.innerHTML = approvalCard(approval, requestValue, options, queued, key);
    approvalRoot.querySelectorAll('[data-approval-choice]').forEach((button) => button.addEventListener('click', () => { void submitApproval(workflow, approval, button.dataset.approvalChoice); }));
    approvalRoot.querySelector('.approval-other-actions').addEventListener('toggle', (event) => { if (event.currentTarget.open) state.openApprovalDetails.add(key); else state.openApprovalDetails.delete(key); });
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
    const workflow = selected(); renderWorkflows(); $('workflow-title').textContent = workflow?.title || '等待工作流'; $('workflow-summary').textContent = workflow?.status_reason || workflow?.route_plan?.summary || '选择工作流以查看任务、会话和审查记录。'; $('workflow-state').textContent = workflow?.state || 'UNKNOWN'; $('workflow-state').className = `state-pill ${String(workflow?.state || 'unknown').toLowerCase()}`; $('workflow-step').textContent = workflow ? `STEP ${(workflow.current_step_index ?? 0) + 1}/${workflow.route_plan?.steps?.length ?? 0}` : 'STEP --'; renderWorkflowControl(workflow); renderTaskList(workflow); renderNotices(workflow); renderSnapshots(workflow); renderHr(workflow); void renderSession(workflow);
  }
  function applySnapshot(snapshot) { state.snapshot = snapshot; state.workflows = snapshot.workflows || []; if (!state.workflows.some((item) => item.workflow_id === state.selectedWorkflowId)) state.selectedWorkflowId = state.workflows[0]?.workflow_id || null; render(); $('sync-state').textContent = time(snapshot.generated_at); setConnection(true, snapshot.kernel_reachable ? 'KERNEL CONNECTED' : 'KERNEL DEGRADED'); }
  function stream() {
    if (state.source) state.source.close(); const source = new EventSource(`${state.apiUrl}/api/workflows/stream`); state.source = source;
    source.addEventListener('snapshot', (event) => { const value = JSON.parse(event.data).payload; if (value) applySnapshot(value); });
    source.addEventListener('activity', (event) => { const activity = JSON.parse(event.data).payload; const key = activity?.payload?.agent_id && activity?.session_id ? `${activity.payload.agent_id}:${activity.session_id}` : null; if (key) state.dirtySessionKeys.add(key); if (key === state.selectedSessionKey) void renderSession(selected()); }); source.addEventListener('hr-alert', () => { void reload(); }); source.onerror = () => setConnection(false, 'RECONNECTING');
  }
  async function reload() { try { const result = await request('/api/workflows'); applySnapshot(result); stream(); } catch (error) { setConnection(false, `OFFLINE: ${error.message}`); } }
  window.addEventListener('beforeunload', () => state.source?.close()); void reload();
})();
