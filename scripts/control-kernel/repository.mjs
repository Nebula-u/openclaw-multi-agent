import { newRunId, runIdFor, executionIdFor, artifactIdFor } from './ids.mjs';

const encode = (value) => value === undefined || value === null ? null : JSON.stringify(value);
const decode = (value) => value === undefined || value === null ? undefined : typeof value === 'string' ? JSON.parse(value) : value;
const now = () => new Date().toISOString();
const marks = (items) => items.map(() => '?').join(',');

function mapRun(row) { return row ? { runId: row.run_id, workflowId: row.workflow_id,
  status: row.state, state: row.state, outcome: row.outcome, statusReason: row.status_reason,
  request: decode(row.request), requestSha256: row.request_sha256, targetProjectRootAbs: row.target_project_root_abs,
  baseCommit: row.base_commit, candidateCommit: row.candidate_commit, routeHash: row.route_hash,
  routePlan: decode(row.route_plan), currentStepIndex: row.current_step_index,
  managerSessionId: row.manager_session_id, managerSessionKey: row.manager_session_key,
  managerDelivery: decode(row.manager_delivery), createdAt: row.created_at, updatedAt: row.updated_at,
  completedAt: row.completed_at } : undefined; }
function mapTask(row) { return row ? { taskId: row.task_id, runId: row.run_id, kind: row.kind, stepId: row.step_id,
  title: row.title, agentId: row.agent_id, status: row.state, state: row.state, attempt: row.attempt,
  maxAttempts: row.max_attempts, jsonRegenerations: row.json_regenerations, executionRound: row.execution_round,
  routeHash: row.route_hash, inputCommit: row.input_commit, taskGroupId: row.task_group_id,
  parallelSlot: row.parallel_slot, dependsOn: decode(row.depends_on) ?? [], lastError: decode(row.last_error),
  payload: decode(row.task_payload) ?? {}, contextManifest: decode(row.context_manifest),
  createdAt: row.created_at, updatedAt: row.updated_at } : undefined; }
function mapExecution(row) { return row ? { executionId: row.execution_id, taskId: row.task_id, runId: row.run_id,
  attempt: row.attempt, cycle: row.cycle, workerId: row.worker_id, state: row.state, phase: row.phase,
  agentId: row.agent_id, sessionId: row.session_id, pid: row.pid, worktreePathAbs: row.worktree_path_abs,
  artifactRootAbs: row.artifact_root_abs, leaseExpiresAt: row.lease_expires_at, heartbeatAt: row.heartbeat_at,
  startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, error: decode(row.error),
  sandboxAttestation: decode(row.sandbox_attestation) } : undefined; }
function mapArtifact(row) { return row ? { artifactId: row.artifact_id, runId: row.run_id, taskId: row.task_id,
  executionId: row.execution_id, kind: row.kind, uri: row.uri, sha256: row.sha256, sizeBytes: Number(row.size_bytes),
  mediaType: row.media_type, commitSha: row.commit_sha, createdAt: row.created_at } : undefined; }

function conditions(filters) {
  const where = []; const values = [];
  for (const [column, value] of filters) if (value !== null && value !== undefined) {
    if (Array.isArray(value)) { if (value.length) { where.push(`${column} IN (${marks(value)})`); values.push(...value); } }
    else { where.push(`${column}=?`); values.push(value); }
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

export function createRepository(database) {
  if (!database) throw new TypeError('database is required');
  async function upsertRun(fields) {
    const runId = fields.runId ? runIdFor(fields.runId) : newRunId(); const timestamp = now();
    database.run(`INSERT INTO runs (run_id,workflow_id,state,outcome,status_reason,request,request_sha256,target_project_root_abs,
      base_commit,candidate_commit,route_hash,route_plan,current_step_index,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(run_id) DO UPDATE SET workflow_id=excluded.workflow_id,
      state=excluded.state,outcome=excluded.outcome,status_reason=excluded.status_reason,request=excluded.request,
      request_sha256=excluded.request_sha256,target_project_root_abs=excluded.target_project_root_abs,base_commit=excluded.base_commit,
      candidate_commit=excluded.candidate_commit,route_hash=excluded.route_hash,updated_at=excluded.updated_at,completed_at=excluded.completed_at`,
    [runId, fields.workflowId, fields.state ?? 'ACTIVE', fields.outcome ?? null, fields.statusReason ?? null,
      encode(fields.request ?? {}), fields.requestSha256, fields.targetProjectRootAbs, fields.baseCommit, fields.candidateCommit ?? null,
      fields.routeHash ?? null, encode({}), timestamp, timestamp, fields.completedAt ? new Date(fields.completedAt).toISOString() : null]);
    return mapRun(database.get('SELECT * FROM runs WHERE run_id=?', [runId]));
  }
  const getRun = async (runId) => mapRun(database.get('SELECT * FROM runs WHERE run_id=?', [runId]));
  const getRunByWorkflowId = async (workflowId) => mapRun(database.get('SELECT * FROM runs WHERE workflow_id=?', [workflowId]));
  async function listRuns({ limit = 200, states = null } = {}) { const query = conditions([['state', states]]); return database.all(`SELECT * FROM runs ${query.clause} ORDER BY updated_at DESC LIMIT ?`, [...query.values, limit]).map(mapRun); }
  async function setRunState(runId, patch) {
    const sets = ['updated_at=?']; const values = [now()]; const cols = { state: 'state', outcome: 'outcome', statusReason: 'status_reason', completedAt: 'completed_at', routeHash: 'route_hash' };
    for (const [key, column] of Object.entries(cols)) if (patch[key] !== undefined) { sets.push(`${column}=?`); values.push(patch[key] instanceof Date ? patch[key].toISOString() : patch[key]); }
    database.run(`UPDATE runs SET ${sets.join(',')} WHERE run_id=?`, [...values, runId]); return getRun(runId);
  }
  async function upsertTask(fields) {
    const timestamp = now();
    database.run(`INSERT INTO tasks (task_id,run_id,kind,step_id,title,agent_id,state,attempt,max_attempts,json_regenerations,execution_round,
      route_hash,input_commit,task_group_id,parallel_slot,depends_on,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,attempt=excluded.attempt,last_error=excluded.last_error,updated_at=excluded.updated_at`,
    [fields.taskId, fields.runId, fields.kind, fields.stepId, fields.title, fields.agentId, fields.state ?? 'READY', fields.attempt ?? 1,
      fields.maxAttempts ?? 3, fields.jsonRegenerations ?? 0, fields.executionRound ?? 1, fields.routeHash ?? null,
      fields.inputCommit ?? null, fields.taskGroupId ?? fields.taskId, fields.parallelSlot ?? 0, encode(fields.dependsOn ?? []),
      encode(fields.lastError), timestamp, timestamp]);
    return mapTask(database.get('SELECT * FROM tasks WHERE task_id=?', [fields.taskId]));
  }
  const getTask = async (taskId) => mapTask(database.get('SELECT * FROM tasks WHERE task_id=?', [taskId]));
  async function listTasks({ runId = null, states = null, limit = 1000 } = {}) { const query = conditions([['run_id',runId],['state',states]]); return database.all(`SELECT * FROM tasks ${query.clause} ORDER BY created_at ASC LIMIT ?`, [...query.values,limit]).map(mapTask); }
  async function setTaskState(taskId, patch) {
    const sets = ['updated_at=?']; const values = [now()]; const cols = { state: ['state',false], attempt: ['attempt',false], lastError: ['last_error',true], executionRound: ['execution_round',false], routeHash: ['route_hash',false] };
    for (const [key,[column,json]] of Object.entries(cols)) if (patch[key] !== undefined) { sets.push(`${column}=?`); values.push(json ? encode(patch[key]) : patch[key]); }
    database.run(`UPDATE tasks SET ${sets.join(',')} WHERE task_id=?`, [...values,taskId]); return getTask(taskId);
  }
  const getExecution = async (executionId) => mapExecution(database.get('SELECT * FROM executions WHERE execution_id=?',[executionId]));
  async function listExecutions({ taskId=null,runId=null,limit=1000 }={}) { const query=conditions([['task_id',taskId],['run_id',runId]]); return database.all(`SELECT * FROM executions ${query.clause} ORDER BY started_at DESC LIMIT ?`,[...query.values,limit]).map(mapExecution); }
  async function upsertArtifact(fields) {
    database.run(`INSERT INTO artifacts (artifact_id,run_id,task_id,execution_id,kind,uri,sha256,size_bytes,media_type,commit_sha,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes`,
    [fields.artifactId,fields.runId,fields.taskId,fields.executionId??null,fields.kind,fields.uri,fields.sha256,fields.sizeBytes??0,
      fields.mediaType??'application/json',fields.commitSha??null,now()]);
    return mapArtifact(database.get('SELECT * FROM artifacts WHERE artifact_id=?',[fields.artifactId]));
  }
  async function listArtifacts({ runId=null,taskId=null,kind=null,limit=1000 }={}) { const query=conditions([['run_id',runId],['task_id',taskId],['kind',kind]]); return database.all(`SELECT * FROM artifacts ${query.clause} ORDER BY created_at ASC LIMIT ?`,[...query.values,limit]).map(mapArtifact); }
  async function projectRuns({ limit=200 }={}) {
    const runs=await listRuns({limit}); return Promise.all(runs.map(async(run)=>{ const tasks=await listTasks({runId:run.runId}); const executions=await listExecutions({runId:run.runId,limit:2000}); const artifacts=await listArtifacts({runId:run.runId,limit:5000});
      const executionByTask={}; for(const execution of executions) if(!executionByTask[execution.taskId]) executionByTask[execution.taskId]={...execution,execution_id:execution.executionId,worker_id:execution.workerId,heartbeat_at:execution.heartbeatAt,lease_expires_at:execution.leaseExpiresAt};
      const artifactsByTask={}; for(const artifact of artifacts) (artifactsByTask[artifact.taskId]??=[]).push({...artifact,artifact_id:artifact.artifactId});
      return {...run,run_id:run.runId,workflow_id:run.workflowId,tasks,executions:executionByTask,artifacts:artifactsByTask}; }));
  }
  return { id:'kernel-repository',upsertRun,getRun,getRunByWorkflowId,listRuns,projectRuns,setRunState,upsertTask,getTask,listTasks,setTaskState,getExecution,listExecutions,upsertArtifact,listArtifacts };
}

export { newRunId, runIdFor, executionIdFor, artifactIdFor };
