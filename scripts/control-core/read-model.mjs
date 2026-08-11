function parseJson(value) { return value == null ? null : JSON.parse(value); }

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

const HISTORY_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'LOST']);

function managerTask(task) {
  return {
    task_id: task.task_id,
    task_type: task.task_type,
    status: task.status,
    assigned_agent: task.assigned_agent,
    run_id: task.run_id,
    attempt: task.attempt,
    max_attempts: task.max_attempts,
    input_commit: task.input_commit ?? null,
    updated_at: task.updated_at,
  };
}

function managerApproval(database, workflowId) {
  if (!tableExists(database, 'approval_requests')) return [];
  return database.prepare(`SELECT decision_id, workflow_id, task_id, run_id, status, request_json, response_json,
      created_at, updated_at FROM approval_requests WHERE workflow_id=? ORDER BY created_at`).all(workflowId).map((row) => {
    const request = parseJson(row.request_json) ?? {};
    const response = parseJson(row.response_json);
    return {
      decision_id: row.decision_id,
      workflow_id: row.workflow_id,
      task_id: row.task_id,
      run_id: row.run_id,
      status: row.status,
      trigger: request.trigger ?? null,
      summary: request.summary ?? null,
      outcome: response?.outcome ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

function managerEvent(database, workflowId) {
  const row = database.prepare(`SELECT seq, revision, event_type, actor, occurred_at
      FROM workflow_events WHERE workflow_id=? ORDER BY seq DESC LIMIT 1`).get(workflowId);
  return row ?? null;
}

function managerDispatchOutbox(database, workflowId) {
  if (!tableExists(database, 'dispatch_outbox')) return [];
  return database.prepare(`SELECT outbox.dispatch_id, dispatch.task_id, dispatch.run_id, outbox.status,
      outbox.attempts, outbox.created_at, outbox.delivered_at
      FROM dispatch_outbox AS outbox
      JOIN dispatches AS dispatch ON dispatch.dispatch_id=outbox.dispatch_id
      WHERE dispatch.workflow_id=? AND outbox.status <> 'DELIVERED'
      ORDER BY outbox.created_at`).all(workflowId);
}

export function createManagerContextSnapshot(database, { workflowId } = {}) {
  if (!workflowId) throw new Error('manager context snapshot requires workflowId');
  const row = database.prepare('SELECT * FROM workflows WHERE workflow_id=?').get(workflowId);
  if (!row) return null;
  const state = parseJson(row.state_json);
  const allTasks = tableExists(database, 'tasks')
    ? database.prepare('SELECT task_json FROM tasks WHERE workflow_id=? ORDER BY updated_at DESC, task_id DESC')
      .all(workflowId).map((taskRow) => parseJson(taskRow.task_json))
    : [];
  const activeTasks = allTasks.filter((task) => !HISTORY_TASK_STATUSES.has(task.status));
  return {
    schema_version: 1,
    view: 'manager-context',
    generated_at: new Date().toISOString(),
    workflow: {
      ...state,
      latest_event: managerEvent(database, workflowId),
    },
    active_tasks: activeTasks.map(managerTask),
    pending_approvals: managerApproval(database, workflowId).filter((item) => item.status === 'PENDING'),
    dispatch_outbox: managerDispatchOutbox(database, workflowId),
    omitted: {
      historical_tasks: true,
      dispatch_receipts: true,
      completion_payloads: true,
      raw_logs: true,
      historical_events: true,
    },
  };
}

export function createControlSnapshot(database, { workflowId = null, view = 'full' } = {}) {
  if (view === 'manager') return createManagerContextSnapshot(database, { workflowId });
  const workflowRows = workflowId
    ? database.prepare('SELECT * FROM workflows WHERE workflow_id=?').all(workflowId)
    : database.prepare('SELECT * FROM workflows ORDER BY updated_at DESC, workflow_id').all();
  const workflows = workflowRows.map((row) => {
    const allTasks = tableExists(database, 'tasks')
      ? database.prepare('SELECT * FROM tasks WHERE workflow_id=? ORDER BY created_at, task_id').all(row.workflow_id).map((taskRow) => {
        // A retry retains its task_id but gets a new run_id.  Never attach
        // dispatches from an older run to the current task snapshot.
        const dispatches = database.prepare('SELECT * FROM dispatches WHERE task_id=? AND run_id=? ORDER BY created_at').all(taskRow.task_id, taskRow.run_id).map((dispatchRow) => ({
          dispatch_id: dispatchRow.dispatch_id,
          status: dispatchRow.status,
          session_key: dispatchRow.session_key,
          session_id: dispatchRow.session_id,
          attempt: dispatchRow.attempt,
          agent_id: dispatchRow.agent_id,
          created_at: dispatchRow.created_at,
          updated_at: dispatchRow.updated_at,
          intent: parseJson(dispatchRow.intent_json),
          receipt: parseJson(dispatchRow.latest_receipt_json),
          completion: parseJson(dispatchRow.completion_json),
        }));
        return { ...parseJson(taskRow.task_json), dispatches };
      })
      : [];
    // The task deck is an operational view. Terminal and superseded attempts
    // remain available as immutable history, but must not look like parallel
    // work that is currently assigned to the same Agent.
    const tasks = allTasks.filter((task) => !HISTORY_TASK_STATUSES.has(task.status));
    const history_tasks = allTasks.filter((task) => HISTORY_TASK_STATUSES.has(task.status));
    return { ...parseJson(row.state_json), tasks, history_tasks };
  });
  let supervision = [];
  if (tableExists(database, 'supervision_requests')) {
    const rows = workflowId
      ? database.prepare('SELECT * FROM supervision_requests WHERE workflow_id=? ORDER BY requested_at').all(workflowId)
      : database.prepare('SELECT * FROM supervision_requests ORDER BY requested_at').all();
    supervision = rows.map((row) => ({ ...parseJson(row.request_json), status: row.status, claimed_by: row.claimed_by,
      claimed_at: row.claimed_at, completed_at: row.completed_at, result_code: row.result_code,
      result_summary: row.result_summary, attempt: row.attempt }));
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    workflow_id: workflowId,
    workflows,
    supervision,
  };
}
