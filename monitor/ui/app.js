(function () {
  'use strict';
  const PHASES = ['INTAKE','REQUIREMENTS','REQUIREMENT_GATE','ARCHITECTURE','ARCHITECTURE_GATE','DEVELOPMENT','CODE_REVIEW','DEVELOPER_REWORK','TESTING','TEST_CODE_REVIEW','FAILURE_TRIAGE','RELEASE_VERIFICATION','FINAL_REPORT'];
  const state = { apiUrl: localStorage.getItem('monitor.apiUrl') || window.MONITOR_CONFIG?.apiUrl || 'http://127.0.0.1:4310', token: sessionStorage.getItem('monitor.token') || '', workflows: [], supervision: [], selectedId: null, source: null, feed: [] };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/gu, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
  const formatTime = (value) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString('zh-CN',{hour12:false}); };
  const selected = () => state.workflows.find((workflow) => workflow.workflow_id === state.selectedId) || null;
  const request = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers['x-monitor-token'] = state.token;
    const response = await fetch(`${state.apiUrl}${path}`, { ...options, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  };
  function setConnection(status, label) { const node = $('connection-state'); node.className = `signal ${status}`; node.innerHTML = `<i></i> ${escapeHtml(label)}`; }
  function renderMetrics(health) {
    const tasks = state.workflows.flatMap((workflow) => workflow.tasks || []);
    $('metric-workflows').textContent = state.workflows.filter((workflow) => workflow.condition !== 'TERMINAL').length;
    $('metric-running').textContent = tasks.filter((task) => task.status === 'RUNNING').length;
    $('metric-waiting').textContent = tasks.filter((task) => ['WAITING_HUMAN','BLOCKED','NEEDS_REWORK'].includes(task.status)).length;
    $('metric-supervision').textContent = state.supervision.filter((item) => ['REQUESTED','CLAIMED'].includes(item.status)).length;
    $('metric-control').textContent = health?.status || 'CONNECTED'; $('last-sync').textContent = `LAST SYNC ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`;
  }
  function renderWorkflowList() {
    const root = $('workflow-list');
    if (!state.workflows.length) { root.className = 'workflow-list empty-state'; root.textContent = '当前没有 workflow'; return; }
    root.className = 'workflow-list'; root.innerHTML = '';
    state.workflows.forEach((workflow) => { const button = document.createElement('button'); button.className = `workflow-button ${workflow.workflow_id === state.selectedId ? 'active' : ''}`;
      button.innerHTML = `<strong>${escapeHtml(workflow.workflow_id)}</strong><span>${escapeHtml(workflow.phase)} / ${escapeHtml(workflow.condition)} · ${workflow.tasks?.length || 0} TASKS</span>`;
      button.addEventListener('click', () => selectWorkflow(workflow.workflow_id)); root.appendChild(button); });
  }
  function renderPhaseRail(workflow) { const current = PHASES.indexOf(workflow?.phase); $('phase-rail').innerHTML = PHASES.map((phase,index) => `<span class="phase-node ${index < current ? 'done' : index === current ? 'current' : ''}">${escapeHtml(phase.replaceAll('_',' '))}</span>`).join(''); }
  function latestDispatch(task) { return task.dispatches?.at(-1) || null; }
  function renderTasks(workflow) {
    const root = $('task-board'); const tasks = workflow?.tasks || [];
    if (!tasks.length) { root.className = 'task-board empty-state'; root.textContent = '这个 workflow 尚无 task'; return; }
    root.className = 'task-board'; root.innerHTML = '';
    tasks.forEach((task) => { const card = $('task-card-template').content.firstElementChild.cloneNode(true); const dispatch = latestDispatch(task);
      card.querySelector('.task-type').textContent = task.task_type || 'TASK'; card.querySelector('.task-status').textContent = task.status;
      card.querySelector('.task-title').textContent = task.title || task.task_id; card.querySelector('.task-agent').textContent = `AGENT / ${task.assigned_agent || 'UNASSIGNED'}`;
      card.querySelector('.task-session').textContent = `SESSION / ${dispatch?.session_id || dispatch?.session_key || 'NOT STARTED'}`;
      card.querySelector('.task-attempt').textContent = `ATTEMPT ${task.attempt || 0}/${task.max_attempts || '—'}`; card.querySelector('.task-time').textContent = formatTime(task.updated_at);
      card.addEventListener('click', () => openTask(task)); root.appendChild(card); });
  }
  function renderAgents(workflow) { const root = $('agent-tree'); const tasks = workflow?.tasks || []; const agents = new Map(); tasks.forEach((task) => agents.set(task.assigned_agent || 'unassigned', task));
    if (!agents.size) { root.className = 'agent-tree empty-state'; root.textContent = '暂无 Agent 数据'; return; } root.className = 'agent-tree'; root.innerHTML = `<div class="agent-node running"><strong>manager-agent</strong><span>唯一编排者 / ${escapeHtml(workflow.phase)}</span></div>`;
    agents.forEach((task, agent) => { const node = document.createElement('div'); node.className = `agent-node ${String(task.status).toLowerCase()}`; node.innerHTML = `<strong>${escapeHtml(agent)}</strong><span>${escapeHtml(task.status)} · ${escapeHtml(task.title || task.task_id)}</span>`; root.appendChild(node); }); }
  function renderSelected() { const workflow = selected(); renderWorkflowList(); if (!workflow) return;
    $('workflow-id').textContent = workflow.workflow_id; $('workflow-title').textContent = workflow.phase.replaceAll('_',' '); $('workflow-condition').textContent = workflow.condition; $('workflow-condition').className = `pill ${String(workflow.condition).toLowerCase()}`; $('workflow-revision').textContent = `REV ${workflow.revision}`;
    renderPhaseRail(workflow); renderTasks(workflow); renderAgents(workflow); }
  function selectWorkflow(id) { state.selectedId = id; renderSelected(); connectStream(); }
  function summaryOf(event) { const payload = event.payload || {}; if (event.type === 'snapshot') return `控制快照已同步 · ${payload.workflows?.length ?? payload.snapshot?.workflows?.length ?? '—'} workflows`;
    if (event.type === 'activity') return payload.payload?.summary || payload.payload?.current_action || payload.event_type || 'Agent activity';
    if (event.type === 'supervision') return payload.request?.reason || payload.command || '监督请求更新'; return payload.status || payload.error || event.type; }
  function addFeed(event) { state.feed.unshift(event); state.feed = state.feed.slice(0,200); renderFeed(); }
  function renderFeed() { const filter = $('feed-filter').value; const events = state.feed.filter((event) => filter === 'all' || event.type === filter || (filter === 'health' && event.type === 'monitor-health'));
    $('event-feed').innerHTML = events.length ? events.map((event) => `<li class="event-row"><time>${formatTime(event.timestamp)}</time><b>${escapeHtml(event.type)}</b><p>${escapeHtml(summaryOf(event))}</p></li>`).join('') : '<li class="empty-state">当前筛选没有事件</li>'; }
  async function openTask(task) { const dialog = $('task-dialog'); const dispatch = latestDispatch(task); let activities = []; try { activities = (await request(`/api/tasks/${encodeURIComponent(task.task_id)}/activity`)).activities; } catch (_) { activities = []; }
    $('task-detail').innerHTML = `<span class="eyebrow">${escapeHtml(task.task_id)}</span><h2 class="detail-title">${escapeHtml(task.title || task.task_type)}</h2><div class="detail-grid">
      ${[['STATUS',task.status],['AGENT',task.assigned_agent],['RUN',task.run_id],['DISPATCH',dispatch?.dispatch_id || '—'],['SESSION',dispatch?.session_id || dispatch?.session_key || '—'],['ARTIFACT',task.artifact_root_abs || '—']].map(([label,value]) => `<div class="detail-cell"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
      <h3>RECENT ACTIVITY</h3><ul class="activity-list">${activities.length ? activities.slice(0,20).map((item) => `<li><b>${escapeHtml(item.kind)}</b> · ${escapeHtml(item.summary)}<br><small>${formatTime(item.timestamp)}</small></li>`).join('') : '<li>暂无显式 activity</li>'}</ul>
      <div class="nudge-form"><label for="nudge-reason">监督请求说明</label><textarea id="nudge-reason">请汇报当前 checkpoint、已完成事实、阻塞原因和下一步；不要重新执行已完成副作用。</textarea><button id="nudge-button" class="button primary">创建 NUDGE 请求</button></div>`;
    $('nudge-button').addEventListener('click', () => createNudge(task)); dialog.showModal(); }
  async function createNudge(task) { const dispatch = latestDispatch(task); const now = new Date(); const uuid = crypto.randomUUID(); const reason = $('nudge-reason').value.trim();
    const body = { schema_version:1, request_id:`SUP-${uuid}`, idempotency_key:`${task.workflow_id}/${task.task_id}/${task.run_id}/NUDGE/${Math.floor(now.valueOf()/300000)}`,
      workflow_id:task.workflow_id, task_id:task.task_id, run_id:task.run_id, dispatch_id:dispatch?.dispatch_id || null, target_agent_id:task.assigned_agent,
      request_type:'NUDGE', source:'LOCAL_USER', reason, evidence:{ source:'static-dashboard', requested_for_status:task.status }, requested_at:now.toISOString() };
    try { const result = await request('/api/supervision/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); addFeed({type:'supervision',timestamp:now.toISOString(),payload:result}); alert('监督请求已创建，等待 manager 处理。'); }
    catch (error) { alert(`创建失败：${error.message}`); } }
  function connectStream() { state.source?.close(); const workflow = selected(); if (!workflow || !state.token) return; const after = Number(localStorage.getItem(`monitor.seq.${workflow.workflow_id}`) || 0);
    const source = new EventSource(`${state.apiUrl}/api/workflows/${encodeURIComponent(workflow.workflow_id)}/stream?after=${after}&token=${encodeURIComponent(state.token)}`); state.source = source;
    ['snapshot','activity','supervision','health','monitor-health'].forEach((type) => source.addEventListener(type,(message) => { const event = JSON.parse(message.data); if (event.sequence) localStorage.setItem(`monitor.seq.${workflow.workflow_id}`,event.sequence); if (type === 'snapshot') { const snapshot = event.payload; const workflows = snapshot.workflows || snapshot.snapshot?.workflows; if (workflows) { state.workflows = workflows; state.supervision = snapshot.supervision || []; if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null; renderSelected(); renderMetrics(); } } addFeed(event); }));
    source.onopen = () => setConnection('online','LIVE / SSE'); source.onerror = () => setConnection('degraded','RECONNECTING'); }
  async function connect() { state.apiUrl = $('api-url').value.trim().replace(/\/$/u,''); state.token = $('api-token').value.trim(); localStorage.setItem('monitor.apiUrl',state.apiUrl); sessionStorage.setItem('monitor.token',state.token); setConnection('degraded','CONNECTING');
    try { const [health,workflows,supervision] = await Promise.all([request('/api/health'),request('/api/workflows'),request('/api/supervision')]); state.workflows = workflows.workflows || []; state.supervision = supervision.requests || []; if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null; renderMetrics(health); renderSelected(); setConnection(health.ok ? 'online':'degraded',health.status); connectStream(); }
    catch (error) { setConnection('offline','OFFLINE'); $('metric-control').textContent = 'UNREACHABLE'; addFeed({type:'monitor-health',timestamp:new Date().toISOString(),payload:{error:error.message}}); } }
  $('api-url').value = state.apiUrl; $('api-token').value = state.token; $('connect-button').addEventListener('click',connect); $('feed-filter').addEventListener('change',renderFeed); $('clear-feed').addEventListener('click',() => { state.feed=[]; renderFeed(); });
  window.addEventListener('beforeunload',() => state.source?.close());
  if (state.token) connect(); else { renderPhaseRail(null); }
}());
