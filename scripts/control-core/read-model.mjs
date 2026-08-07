function parseJson(value) { return value == null ? null : JSON.parse(value); }

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

const HISTORY_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'LOST']);

export function createControlSnapshot(database, { workflowId = null } = {}) {
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
