(function () {
  'use strict';
  const PHASES = ['INTAKE','REQUIREMENTS','REQUIREMENT_GATE','ARCHITECTURE','ARCHITECTURE_GATE','DEVELOPMENT','CODE_REVIEW','DEVELOPER_REWORK','TESTING','TEST_CODE_REVIEW','FAILURE_TRIAGE','RELEASE_VERIFICATION','FINAL_REPORT'];
  const defaultApiUrl = window.MONITOR_CONFIG?.apiUrl || 'http://127.0.0.1:4319';
  const fixedSameOriginApi = defaultApiUrl.startsWith('/');
  const state = { apiUrl: fixedSameOriginApi ? defaultApiUrl : (localStorage.getItem('monitor.apiUrl') || defaultApiUrl), workflows: [], selectedId: null, source: null, feed: [], agents: [], selectedAgentId: null, sessions: [], selectedSessionId: null, conversationTimer: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/gu, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
  const formatTime = (value) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString('zh-CN',{hour12:false}); };
  const selected = () => state.workflows.find((workflow) => workflow.workflow_id === state.selectedId) || null;
  const request = async (path) => { const response = await fetch(`${state.apiUrl}${path}`); const body = await response.json(); if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`); return body; };
  function setConnection(status, label) { const node = $('connection-state'); node.className = `signal ${status}`; node.innerHTML = `<i></i> ${escapeHtml(label)}`; }
  function renderMetrics(health) {
    const tasks = state.workflows.flatMap((workflow) => workflow.tasks || []);
    $('metric-workflows').textContent = state.workflows.filter((workflow) => workflow.condition !== 'TERMINAL').length;
    $('metric-running').textContent = state.agents.length;
    $('metric-waiting').textContent = tasks.filter((task) => ['WAITING_HUMAN','BLOCKED','NEEDS_REWORK'].includes(task.status) || ['STALE','POSSIBLY_STALLED'].includes(task.health?.health)).length;
    $('metric-control').textContent = health?.status || 'CONNECTED';
    $('last-sync').textContent = `LAST SYNC ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`;
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
  const latestDispatch = (task) => task.dispatches?.at(-1) || null;
  function renderTasks(workflow) {
    const root = $('task-board'); const tasks = workflow?.tasks || [];
    if (!tasks.length) { root.className = 'task-board empty-state'; root.textContent = '这个 workflow 尚无 task'; return; }
    root.className = 'task-board'; root.innerHTML = '';
    tasks.forEach((task) => { const card = $('task-card-template').content.firstElementChild.cloneNode(true); const dispatch = latestDispatch(task);
      card.querySelector('.task-type').textContent = task.task_type || 'TASK'; card.querySelector('.task-status').textContent = task.health?.health || task.status;
      card.querySelector('.task-title').textContent = task.title || task.task_id; card.querySelector('.task-agent').textContent = `AGENT / ${task.assigned_agent || 'UNASSIGNED'}`;
      card.querySelector('.task-session').textContent = `EXECUTION / ${dispatch?.status || 'NOT STARTED'}`;
      card.querySelector('.task-attempt').textContent = `ATTEMPT ${task.attempt || 0}/${task.max_attempts || '—'}`; card.querySelector('.task-time').textContent = formatTime(task.updated_at);
      card.addEventListener('click', () => openTask(task)); root.appendChild(card); });
  }
  function renderAgents(workflow) { const root = $('agent-tree'); const tasks = workflow?.tasks || []; const agents = new Map(); tasks.forEach((task) => agents.set(task.assigned_agent || 'unassigned', task));
    if (!agents.size) { root.className = 'agent-tree empty-state'; root.textContent = '暂无 Agent 数据'; return; } root.className = 'agent-tree'; root.innerHTML = `<div class="agent-node running"><strong>local-orchestrator</strong><span>本地编排 / ${escapeHtml(workflow.phase)}</span></div>`;
    agents.forEach((task, agent) => { const health = task.health?.health || task.status; const node = document.createElement('div'); node.className = `agent-node ${String(health).toLowerCase()}`; node.innerHTML = `<strong>${escapeHtml(agent)}</strong><span>${escapeHtml(health)} · ${escapeHtml(task.title || task.task_id)}</span>`; root.appendChild(node); }); }
  function renderConversationAgents() { const root = $('conversation-agent-list'); if (!state.agents.length) { root.innerHTML = '<div class="empty-state">没有发现 Agent</div>'; return; }
    root.innerHTML = ''; state.agents.forEach((agent) => { const button = document.createElement('button'); const active = agent.agent_id === state.selectedAgentId; button.className = `conversation-agent ${active ? 'active' : ''}`;
      button.innerHTML = `<i class="agent-state ${escapeHtml(agent.status)}"></i><span><strong>${escapeHtml(agent.agent_id)}</strong><small>${escapeHtml(agent.status)} · ${agent.session_count} SESSIONS</small></span><em>${agent.active_session_count || ''}</em>`;
      button.addEventListener('click', () => selectConversationAgent(agent.agent_id)); root.appendChild(button); }); }
  function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN',{hour12:false}); }
  function renderSessionOptions() { const select = $('session-select'); select.disabled = !state.sessions.length; select.innerHTML = state.sessions.length ? state.sessions.map((session) => `<option value="${escapeHtml(session.session_id)}" ${session.session_id === state.selectedSessionId ? 'selected' : ''}>${escapeHtml(formatDateTime(session.updated_at || session.started_at))} · ${escapeHtml(session.status)}${session.total_tokens === null ? '' : ` · ${session.total_tokens.toLocaleString()} tok`}</option>`).join('') : '<option>暂无 session</option>'; }
  function renderConversation(messages, session, truncated) { const root = $('conversation-history'); if (!session) { root.innerHTML = '<div class="conversation-empty"><b>NO SESSION</b><span>这个 Agent 尚未产生持久会话。</span></div>'; return; }
    if (!messages.length) { root.innerHTML = '<div class="conversation-empty"><b>EMPTY SESSION</b><span>当前 session 没有可公开的 user / assistant 文本。</span></div>'; return; }
    root.innerHTML = `${truncated ? '<div class="history-notice">只显示最近 500 条安全对话</div>' : ''}${messages.map((message) => `<article class="message ${escapeHtml(message.role)}"><header><b>${message.role === 'user' ? 'USER' : 'AGENT'}</b><time>${escapeHtml(formatDateTime(message.timestamp))}</time></header><div>${escapeHtml(message.text)}</div></article>`).join('')}`; root.scrollTop = root.scrollHeight; }
  async function loadConversation() { if (!state.selectedAgentId || !state.selectedSessionId) { renderConversation([],null,false); return; }
    const root = $('conversation-history'); root.setAttribute('aria-busy','true'); try { const body = await request(`/api/agents/${encodeURIComponent(state.selectedAgentId)}/sessions/${encodeURIComponent(state.selectedSessionId)}/messages?limit=500`); renderConversation(body.messages || [],body.session,body.truncated); } catch (error) { root.innerHTML = `<div class="conversation-empty error"><b>CONVERSATION UNAVAILABLE</b><span>${escapeHtml(error.message)}</span></div>`; } finally { root.removeAttribute('aria-busy'); } }
  async function selectConversationAgent(agentId) { state.selectedAgentId = agentId; localStorage.setItem('monitor.agentId',agentId); renderConversationAgents(); const agent = state.agents.find((item) => item.agent_id === agentId);
    $('conversation-agent-name').textContent = agentId; $('conversation-agent-status').textContent = agent?.status || 'UNKNOWN'; $('conversation-agent-meta').textContent = `${agent?.session_count || 0} sessions · ${agent?.latest_session_at ? `最近活动 ${formatDateTime(agent.latest_session_at)}` : '尚无活动'}`;
    try { state.sessions = (await request(`/api/agents/${encodeURIComponent(agentId)}/sessions`)).sessions || []; const saved = localStorage.getItem(`monitor.session.${agentId}`); state.selectedSessionId = state.sessions.some((item) => item.session_id === saved) ? saved : state.sessions[0]?.session_id || null; renderSessionOptions(); await loadConversation(); } catch (error) { state.sessions=[]; state.selectedSessionId=null; renderSessionOptions(); renderConversation([],null,false); } }
  async function loadAgents({ preserve = true } = {}) { const body = await request('/api/agents'); state.agents = body.agents || []; let selectedId = preserve ? state.selectedAgentId : null; if (!state.agents.some((item) => item.agent_id === selectedId)) { const saved = localStorage.getItem('monitor.agentId'); selectedId = state.agents.some((item) => item.agent_id === saved) ? saved : state.agents[0]?.agent_id || null; }
    renderConversationAgents(); if (selectedId && selectedId !== state.selectedAgentId) await selectConversationAgent(selectedId); else if (!selectedId) renderConversation([],null,false); }
  function renderSelected() { const workflow = selected(); renderWorkflowList(); if (!workflow) return;
    $('workflow-id').textContent = workflow.workflow_id; $('workflow-title').textContent = workflow.phase.replaceAll('_',' '); $('workflow-condition').textContent = workflow.condition; $('workflow-condition').className = `pill ${String(workflow.condition).toLowerCase()}`; $('workflow-revision').textContent = `REV ${workflow.revision}`;
    renderPhaseRail(workflow); renderTasks(workflow); renderAgents(workflow); }
  function summaryOf(event) { const payload = event.payload || {}; if (event.type === 'snapshot') return `控制快照已同步 · ${payload.workflows?.length ?? '—'} workflows`;
    if (event.type === 'activity' && payload.event_type === 'session.assistant_output') return payload.payload?.summary || 'Agent 已输出用户可见消息';
    if (event.type === 'activity') return '任务产物或状态已由本地采集器更新';
    return payload.health || payload.status || payload.error || event.type; }
  function addFeed(event) { if (event.type === 'activity' && event.payload?.event_type !== 'session.assistant_output') return; state.feed.unshift(event); state.feed = state.feed.slice(0,200); renderFeed(); }
  function renderFeed() { const filter = $('feed-filter').value; const events = state.feed.filter((event) => filter === 'all' || event.type === filter || (filter === 'health' && event.type === 'monitor-health'));
    $('event-feed').innerHTML = events.length ? events.map((event) => `<li class="event-row"><time>${formatTime(event.timestamp)}</time><b>${escapeHtml(event.type)}</b><p>${escapeHtml(summaryOf(event))}</p></li>`).join('') : '<li class="empty-state">当前筛选没有事件</li>'; }
  async function openTask(task) { const dialog = $('task-dialog'); let dialogue = []; try { dialogue = (await request(`/api/tasks/${encodeURIComponent(task.task_id)}/activity`)).dialogue; } catch (_) { dialogue = []; }
    $('task-detail').innerHTML = `<span class="eyebrow">${escapeHtml(task.task_id)}</span><h2 class="detail-title">${escapeHtml(task.title || task.task_type)}</h2><div class="detail-grid">
      ${[['STATUS',task.status],['HEALTH',task.health?.health || 'UNKNOWN'],['AGENT',task.assigned_agent],['ATTEMPT',`${task.attempt || 0}/${task.max_attempts || '—'}`]].map(([label,value]) => `<div class="detail-cell"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
      <h3>USER-VISIBLE DIALOGUE</h3><ul class="activity-list">${dialogue.length ? dialogue.slice(0,20).map((item) => `<li>${escapeHtml(item.summary)}<br><small>${escapeHtml(item.agent_id)} · ${formatTime(item.timestamp)}</small></li>`).join('') : '<li>暂无可展示的 Agent 对话</li>'}</ul>`;
    dialog.showModal(); }
  function selectWorkflow(id) { state.selectedId = id; renderSelected(); connectStream(); }
  function connectStream() { state.source?.close(); const workflow = selected(); if (!workflow) return; const after = Number(localStorage.getItem(`monitor.seq.${workflow.workflow_id}`) || 0);
    const source = new EventSource(`${state.apiUrl}/api/workflows/${encodeURIComponent(workflow.workflow_id)}/stream?after=${after}`); state.source = source;
    ['snapshot','activity','health','monitor-health'].forEach((type) => source.addEventListener(type,(message) => { const event = JSON.parse(message.data); if (event.sequence) localStorage.setItem(`monitor.seq.${workflow.workflow_id}`,event.sequence); if (type === 'snapshot') { const workflows = event.payload.workflows; if (workflows) { state.workflows = workflows; if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null; renderSelected(); renderMetrics(); } } addFeed(event); }));
    source.onopen = () => setConnection('online','LIVE / SSE'); source.onerror = () => setConnection('degraded','RECONNECTING'); }
  async function connect() { state.apiUrl = $('api-url').value.trim().replace(/\/$/u,''); localStorage.setItem('monitor.apiUrl',state.apiUrl); setConnection('degraded','CONNECTING');
    try { const [health,workflows] = await Promise.all([request('/api/health'),request('/api/workflows'),loadAgents({preserve:false})]); state.workflows = workflows.workflows || []; if (!state.workflows.some((item) => item.workflow_id === state.selectedId)) state.selectedId = state.workflows[0]?.workflow_id || null; renderMetrics(health); renderSelected(); setConnection(health.ok ? 'online':'degraded',health.status); connectStream(); clearInterval(state.conversationTimer); state.conversationTimer = setInterval(async () => { try { await loadAgents(); if (state.selectedSessionId) await loadConversation(); } catch (_) { /* keep last persistent view during transient refresh errors */ } },5000); }
    catch (error) { setConnection('offline','OFFLINE'); $('metric-control').textContent = 'UNREACHABLE'; addFeed({type:'monitor-health',timestamp:new Date().toISOString(),payload:{error:error.message}}); } }
  async function bootstrap() { if (!fixedSameOriginApi) { for (const apiUrl of [...new Set([defaultApiUrl, state.apiUrl])]) { try { const response = await fetch(`${apiUrl}/api/client-config`); if (!response.ok) continue; const config = await response.json(); state.apiUrl = config.api_url || apiUrl; $('api-url').value = state.apiUrl; localStorage.setItem('monitor.apiUrl',state.apiUrl); break; } catch (_) { /* try the saved address after the configured default */ } } } await connect(); }
  $('api-url').value = state.apiUrl; $('connect-button').addEventListener('click',connect); $('feed-filter').addEventListener('change',renderFeed); $('clear-feed').addEventListener('click',() => { state.feed=[]; renderFeed(); }); $('session-select').addEventListener('change',async (event) => { state.selectedSessionId=event.target.value; localStorage.setItem(`monitor.session.${state.selectedAgentId}`,state.selectedSessionId); await loadConversation(); }); window.addEventListener('beforeunload',() => { state.source?.close(); clearInterval(state.conversationTimer); }); void bootstrap();
}());
