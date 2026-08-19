(() => {
  'use strict';

  const sameOrigin = window.location.protocol !== 'file:';
  const defaultApi = window.MONITOR_CONFIG?.apiUrl || (sameOrigin ? window.location.origin : 'http://127.0.0.1:4319');
  const state = { apiUrl: defaultApi.replace(/\/$/u, ''), workflows: [], selectedId: localStorage.getItem('workdesk.workflow') || null, source: null, workflowListKey: null, dialogueKey: null, interactive: false, controlHeader: 'x-stategraph-control' };
  let latestDraft = null;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<'"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const selected = () => state.workflows.find((workflow) => workflow.workflow_id === state.selectedId) || null;
  const request = async (path, options = {}) => {
    const response = await fetch(`${state.apiUrl}${path}`, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  };
  const controlRequest = (path, options = {}) => request(path, { ...options, headers: { 'content-type': 'application/json', [state.controlHeader]: '1', ...(options.headers || {}) } });
  const messageTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '刚刚';
  const taskRenderState = (task) => [task.task_id, task.title, task.task_type, task.status, task.assigned_agent, task.attempt, task.health?.health, task.last_error?.code, task.last_error?.message];
  const workflowRenderState = (workflow) => workflow ? [workflow.workflow_id, workflow.revision, workflow.title, workflow.condition, workflow.phase, workflow.route_status, workflow.status_reason, workflow.summary, workflow.created_at, workflow.updated_at, workflow.pending_approval, (workflow.tasks || []).map(taskRenderState), (workflow.manager_reports || []).at(-1)] : null;

  function setConnection(connected, label) { $('connection-dot').classList.toggle('online', connected); $('connection-state').textContent = label; }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme; localStorage.setItem('workdesk.theme', theme);
    const dark = theme === 'dark'; $('theme-toggle').querySelector('span').textContent = dark ? '☀' : '☾'; $('theme-toggle').querySelector('em').textContent = dark ? '浅色' : '深色';
  }
  function renderWorkflows() {
    const renderKey = JSON.stringify([state.selectedId, state.workflows.map((workflow) => [workflow.workflow_id, workflow.revision, workflow.title, workflow.condition, workflow.phase, (workflow.tasks || []).map(taskRenderState)])]);
    if (renderKey === state.workflowListKey) return;
    state.workflowListKey = renderKey;
    const root = $('workflow-list'); $('workflow-count').textContent = state.workflows.filter((item) => item.condition !== 'TERMINAL').length;
    if (!state.workflows.length) { root.innerHTML = '<p class="side-empty">尚未发现 workflow</p>'; return; }
    root.innerHTML = state.workflows.map((workflow) => `<button class="workflow-item ${workflow.workflow_id === state.selectedId ? 'active' : ''}" data-workflow-id="${escapeHtml(workflow.workflow_id)}" type="button"><span class="workflow-item-top"><i class="mini-status ${escapeHtml(String(workflow.condition).toLowerCase())}"></i>${escapeHtml(workflow.condition === 'WAITING_HUMAN' ? '等待 CLI 确认' : workflow.phase.replaceAll('_', ' '))}</span><strong>${escapeHtml(workflow.title || workflow.workflow_id)}</strong><small>${escapeHtml(workflow.workflow_id.slice(-12))} · ${workflow.steps?.length || 0} 个阶段</small></button>`).join('');
    root.querySelectorAll('[data-workflow-id]').forEach((button) => button.addEventListener('click', () => selectWorkflow(button.dataset.workflowId)));
  }
  function renderContext(workflow) {
    $('workflow-crumb').textContent = workflow ? workflow.workflow_id : '选择 workflow'; $('workflow-title').textContent = workflow?.title || '未选择';
    const progress = workflow?.condition === 'ACTIVE' ? workflowProgress(workflow) : null;
    $('workflow-summary').textContent = workflow?.route_status === 'PROPOSED' ? '路线已生成，等待你冻结本轮执行计划。' : progress || workflow?.status_reason || workflow?.summary || '—';
    $('workflow-condition').textContent = workflow?.condition || 'UNKNOWN'; $('workflow-condition').className = `status-badge ${String(workflow?.condition || 'unknown').toLowerCase()}`;
    $('workflow-phase').textContent = workflow?.phase?.replaceAll('_', ' ') || '—'; $('revision').textContent = `REV ${workflow?.revision ?? '—'}`;
    const steps = workflow?.steps || [];
    $('task-list').innerHTML = steps.length ? steps.map((step, index) => `<li><i class="task-dot ${escapeHtml(String(step.status || (index < workflow.current_step_index ? 'COMPLETED' : 'PENDING')).toLowerCase())}"></i><div><strong>${escapeHtml(step.title || step.kind)}</strong><span>${escapeHtml(step.kind)} · ${escapeHtml(step.status || (index < workflow.current_step_index ? 'COMPLETED' : 'PENDING'))}</span></div></li>`).join('') : '<li class="side-empty">尚未确认流程</li>';
  }
  function createMessage(kind, label, text, time = null) { return `<article class="message ${kind}"><div class="message-avatar">${kind === 'human' ? '你' : '✦'}</div><div class="message-body"><header><b>${escapeHtml(label)}</b><time>${escapeHtml(messageTime(time))}</time></header><div class="message-copy">${escapeHtml(text)}</div></div></article>`; }
  function workflowProgress(workflow) {
    const active = (workflow.tasks || []).find((task) => ['READY', 'REPAIR_READY', 'DISPATCHED', 'STARTING', 'RUNNING'].includes(task.status));
    if (!active) return null;
    const agent = active.assigned_agent || 'Agent';
    const task = active.title || active.task_type || '当前任务';
    const health = active.health?.health;
    const previousError = active.last_error?.message || active.last_error?.code;
    if (health === 'POSSIBLY_STALLED' || health === 'STALE') return `${agent} 的「${task}」可能已停滞；${previousError ? `最近错误：${previousError}` : '请检查执行记录。'}`;
    if (active.status === 'REPAIR_READY') return `${agent} 正在准备修复「${task}」的结构化输出。`;
    return `${agent} 正在执行「${task}」（第 ${active.attempt || 1} 次尝试）${previousError ? `；已记录上次错误：${previousError}` : ''}`;
  }
  function renderDialogue() {
    const workflow = selected();
    const renderKey = JSON.stringify(workflowRenderState(workflow));
    if (renderKey === state.dialogueKey) return;
    state.dialogueKey = renderKey;
    $('empty-view').hidden = Boolean(workflow); $('conversation').hidden = !workflow; renderContext(workflow); if (!workflow) return;
    const root = $('conversation'); root.innerHTML = '';
    root.insertAdjacentHTML('beforeend', createMessage('human', '你的任务', workflow.title || workflow.workflow_id, workflow.created_at));
    const routeText = workflow.route_status === 'PROPOSED' ? 'Manager 已提出流程，正在等待你在 CLI 中确认。' : workflow.condition === 'WAITING_HUMAN' ? '流程已暂停，等待你在 Manager CLI 中作出决定。' : workflow.condition === 'TERMINAL' ? `本轮流程已结束：${workflow.outcome || workflow.status_reason || '已完成'}。` : `StateGraph 正在推进「${workflow.phase.replaceAll('_', ' ')}」。任务状态会在此实时更新。`;
    root.insertAdjacentHTML('beforeend', createMessage('assistant', 'WorkDesk · StateGraph', routeText, workflow.updated_at));
    if (workflow.manager_reports?.length) { const report = workflow.manager_reports.at(-1); root.insertAdjacentHTML('beforeend', createMessage('system', '最近的执行记录', report.error?.message || report.error?.code || '已记录任务状态变化', report.reported_at)); }
    const progress = !workflow.pending_approval && workflow.condition !== 'TERMINAL' ? workflowProgress(workflow) : null;
    if (progress) root.insertAdjacentHTML('beforeend', `<div class="waiting-line"><i></i><span>${escapeHtml(progress)}</span></div>`);
  }
  function selectWorkflow(workflowId) { state.selectedId = workflowId; localStorage.setItem('workdesk.workflow', workflowId); renderWorkflows(); renderDialogue(); renderControls(); }
  function renderControls() {
    const enabled = state.interactive && Boolean(selected());
    ['run-workflow', 'advance-workflow', 'audit-workflow'].forEach((id) => { const element = $(id); if (element) element.disabled = !enabled; });
    $('history-workflow').disabled = !selected();
    $('new-workflow').disabled = !state.interactive;
  }
  function showControlMessage(message, error = false) { const element = $('control-message'); if (element) { element.textContent = message; element.dataset.error = error ? 'true' : 'false'; } }
  function showChatMessage(message, error = false) { const element = $('chat-message'); if (element) { element.textContent = message; element.dataset.error = error ? 'true' : 'false'; } }
  async function runSelected(kind) {
    const workflow = selected(); if (!workflow) return;
    try { await controlRequest(`/api/workflows/${encodeURIComponent(workflow.workflow_id)}/${kind}`, { method: 'POST', body: '{}' }); await reload(); showControlMessage('操作已提交。'); }
    catch (error) { showControlMessage(error.message, true); }
  }
  function connectStream() {
    if (state.source) return;
    const source = new EventSource(`${state.apiUrl}/api/workflows/stream`); state.source = source;
    source.addEventListener('snapshot', (event) => { const values = JSON.parse(event.data).payload?.workflows; if (values) { state.workflows = values; if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null; renderWorkflows(); renderDialogue(); $('sync-state').textContent = `已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`; } });
    source.onerror = () => setConnection(false, '连接正在恢复');
  }
  async function reload() {
    try {
      const [client, workflows] = await Promise.all([request('/api/client-config'), request('/api/workflows')]); state.interactive = client.interactive_controls === true; state.controlHeader = client.control_token_header || 'x-stategraph-control'; state.workflows = workflows.workflows || [];
      if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null;
      renderWorkflows(); renderDialogue(); renderControls(); connectStream(); setConnection(true, client.mode === 'READ_ONLY' ? '只读监测已连接' : '交互控制已连接'); $('sync-state').textContent = `已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    } catch (error) { setConnection(false, '服务暂不可达'); $('sync-state').textContent = `连接失败 · ${error.message}`; }
  }
  $('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('new-workflow').addEventListener('click', () => { $('new-workflow-panel').hidden = false; $('empty-view').hidden = true; $('conversation').hidden = true; $('new-workflow-text').focus(); });
  $('cancel-new-workflow').addEventListener('click', () => { $('new-workflow-panel').hidden = true; $('empty-view').hidden = !selected(); $('conversation').hidden = !selected(); });
  $('submit-new-workflow').addEventListener('click', async () => {
    const text = $('new-workflow-text').value.trim(); if (!text) return showControlMessage('请填写需求。', true);
    try { await controlRequest('/api/workflows', { method: 'POST', body: JSON.stringify({ text, project_path_abs: $('new-workflow-project').value.trim() || undefined }) }); $('new-workflow-text').value = ''; $('new-workflow-panel').hidden = true; await reload(); showControlMessage('workflow 已创建。'); }
    catch (error) { showControlMessage(error.message, true); }
  });
  $('run-workflow').addEventListener('click', () => runSelected('run'));
  $('advance-workflow').addEventListener('click', () => runSelected('advance'));
  $('audit-workflow').addEventListener('click', async () => { const workflow = selected(); if (!workflow) return; try { const result = await request(`/api/workflows/${encodeURIComponent(workflow.workflow_id)}/audit`); showControlMessage(result.ok ? '事件链审计通过。' : JSON.stringify(result)); } catch (error) { showControlMessage(error.message, true); } });
  $('history-workflow').addEventListener('click', async () => { const workflow = selected(); if (!workflow) return; try { const result = await request(`/api/workflows/${encodeURIComponent(workflow.workflow_id)}/history?limit=20`); showControlMessage((result.history || []).map((item) => `${item.revision ?? '?'} ${item.phase ?? 'UNKNOWN'} ${item.checkpoint_id ?? ''}`).join('\n') || '没有可用的 checkpoint 历史。'); } catch (error) { showControlMessage(error.message, true); } });
  $('chat-send').addEventListener('click', async () => {
    const message = $('chat-input').value.trim(); if (!message) return showChatMessage('请输入消息。', true);
    if (!state.interactive) return showChatMessage('请先以交互模式启动 Monitor。', true);
    try {
      const conversationId = selected()?.workflow_id || 'monitor-chat';
      const result = await controlRequest(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body: JSON.stringify({ message, workflow_id: selected()?.workflow_id ?? null }) });
      latestDraft = result.intent_draft; $('chat-draft').hidden = false; $('chat-draft').textContent = JSON.stringify(latestDraft, null, 2); $('chat-confirm').disabled = false; showChatMessage('草案已生成，请确认后提交。');
    } catch (error) { showChatMessage(error.message, true); }
  });
  $('chat-confirm').addEventListener('click', async () => {
    if (!latestDraft) return; try { await controlRequest('/api/chat/confirm', { method: 'POST', body: JSON.stringify({ intent_id: latestDraft.intent_id, confirmed: true, actor: 'human:monitor-gui' }) }); $('chat-confirm').disabled = true; showChatMessage('已确认并提交。'); await reload(); } catch (error) { showChatMessage(error.message, true); }
  });
  applyTheme(localStorage.getItem('workdesk.theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  window.addEventListener('beforeunload', () => state.source?.close());
  void reload();
})();
