import { randomUUID } from 'node:crypto';
import { artifactIdFor, executionIdFor, newRunId } from './ids.mjs';
import { canonicalJson, sha256Text } from '../runtime-core/atomic-store.mjs';

const RUN_STATES = new Set(['ACTIVE', 'WAITING_HUMAN', 'HOLD', 'TERMINAL']);
const TASK_STATES = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_HUMAN', 'CANCELLED']);
const SNAPSHOT_KINDS = new Set(['ACCEPTED', 'FAILED_RECOVERY', 'NO_CHANGE', 'RESTORE', 'REVERT']);
const HR_KINDS = new Set(['SESSION_REVIEW', 'TASK_REVIEW', 'DAILY_REVIEW']);
const HR_TRIGGERS = new Set(['MANUAL', 'AUTO_TASK', 'AUTO_DAILY']);

function id(prefix) { return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 20)}`; }
function encode(value) { return value === undefined || value === null ? null : JSON.stringify(value); }
function decode(value, fallback = null) { if (value === null || value === undefined) return fallback; return typeof value === 'string' ? JSON.parse(value) : value; }
function iso(value) { const item = value instanceof Date ? value : new Date(value); return item.toISOString(); }
function placeholders(values) { return values.map(() => '?').join(','); }

function runOut(row) {
  if (!row) return null;
  return { runId: row.run_id, workflowId: row.workflow_id, state: row.state, outcome: row.outcome,
    statusReason: row.status_reason, request: decode(row.request, {}), routePlan: decode(row.route_plan),
    currentStepIndex: row.current_step_index, targetProjectRootAbs: row.target_project_root_abs,
    baseCommit: row.base_commit, candidateCommit: row.candidate_commit, routeHash: row.route_hash,
    managerSessionId: row.manager_session_id, managerSessionKey: row.manager_session_key,
    managerDelivery: decode(row.manager_delivery), createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at };
}
function taskOut(row) {
  if (!row) return null;
  return { taskId: row.task_id, runId: row.run_id, kind: row.kind, stepId: row.step_id,
    title: row.title, agentId: row.agent_id, state: row.state, status: row.state,
    attempt: row.attempt, maxAttempts: row.max_attempts, jsonRegenerations: row.json_regenerations,
    executionRound: row.execution_round, inputCommit: row.input_commit,
    routeHash: row.route_hash, lastError: decode(row.last_error), payload: decode(row.task_payload, {}),
    contextManifest: decode(row.context_manifest), createdAt: row.created_at, updatedAt: row.updated_at };
}
function approvalOut(row) { return row ? { decisionId: row.decision_id, runId: row.run_id, taskId: row.task_id, stepId: row.step_id,
  trigger: row.trigger, request: decode(row.request, {}), response: decode(row.response), status: row.status,
  createdAt: row.created_at, resolvedAt: row.resolved_at } : null; }
function notificationOut(row) { return row ? { notificationId: row.notification_id, runId: row.run_id, taskId: row.task_id,
  type: row.type, payload: decode(row.payload, {}), status: row.status, attempts: row.attempts,
  lastError: decode(row.last_error), createdAt: row.created_at, sentAt: row.sent_at, deliveredAt: row.delivered_at } : null; }
function hrJobOut(row) { return row ? { jobId: row.job_id, reviewKey: row.review_key, runId: row.run_id, taskId: row.task_id,
  kind: row.kind, triggerMode: row.trigger_mode, sourceAgentId: row.source_agent_id, sourceSessionId: row.source_session_id,
  input: decode(row.input, {}), result: decode(row.result), hrSessionId: row.hr_session_id, status: row.status,
  attempts: row.attempts, lastError: decode(row.last_error), createdAt: row.created_at, startedAt: row.started_at,
  finishedAt: row.finished_at } : null; }
function snapshotOut(row) { return row ? { snapshotId: row.snapshot_id, runId: row.run_id, taskId: row.task_id,
  executionId: row.execution_id, attempt: row.attempt, agentId: row.agent_id, sessionId: row.session_id,
  inputCommit: row.input_commit, outputCommit: row.output_commit, parentSnapshotId: row.parent_snapshot_id,
  gitRef: row.git_ref, snapshotKind: row.snapshot_kind, changeSummary: decode(row.change_summary, {}),
  worktreePathAbs: row.worktree_path_abs, createdAt: row.created_at } : null; }

export function createWorkflowRepository({ database, clock = () => new Date() }) {
  if (!database) throw new TypeError('database is required');
  const now = () => iso(clock());

  async function createRun({ workflowId, request, requestSha256 = null, routePlan, routeHash = null, targetProjectRootAbs,
    baseCommit = 'UNKNOWN', managerSessionId, managerSessionKey, managerDelivery = null }) {
    const runId = newRunId(); const timestamp = now();
    database.run(`INSERT INTO runs (run_id,workflow_id,state,request,request_sha256,route_plan,current_step_index,
      target_project_root_abs,base_commit,route_hash,manager_session_id,manager_session_key,manager_delivery,created_at,updated_at)
      VALUES (?,?,'ACTIVE',?,?,?,0,?,?,?,?,?,?,?,?)`, [runId, workflowId, encode(request ?? {}),
      requestSha256 ?? sha256Text(canonicalJson(request ?? {})), encode(routePlan ?? {}), targetProjectRootAbs, baseCommit,
      routeHash ?? routePlan?.route_hash ?? sha256Text(canonicalJson(routePlan ?? {})), managerSessionId ?? null, managerSessionKey ?? null,
      encode(managerDelivery), timestamp, timestamp]);
    return getRunById(runId);
  }
  async function getRun(workflowId) { return runOut(database.get('SELECT * FROM runs WHERE workflow_id=?', [workflowId])); }
  async function getRunById(runId) { return runOut(database.get('SELECT * FROM runs WHERE run_id=?', [runId])); }
  async function listRuns({ limit = 200 } = {}) { return database.all('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?', [limit]).map(runOut); }
  async function updateRun(runId, patch) {
    if (patch.state && !RUN_STATES.has(patch.state)) throw Object.assign(new Error(`invalid run state: ${patch.state}`), { code: 'RUN_STATE_INVALID' });
    const columns = { state: ['state', false], outcome: ['outcome', false], statusReason: ['status_reason', false], currentStepIndex: ['current_step_index', false],
      candidateCommit: ['candidate_commit', false], routePlan: ['route_plan', true], routeHash: ['route_hash', false], completedAt: ['completed_at', false] };
    const timestamp = now();
    const sets = ['updated_at=?']; const values = [timestamp];
    for (const [key, [column, json]] of Object.entries(columns)) if (patch[key] !== undefined) { sets.push(`${column}=?`); values.push(json ? encode(patch[key]) : patch[key]); }
    values.push(runId); const result = database.run(`UPDATE runs SET ${sets.join(',')} WHERE run_id=?`, values);
    if (!result.changes) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'RUN_NOT_FOUND' });
    return getRunById(runId);
  }
  async function createTask({ runId, step, agentId, payload = {}, contextManifest = null, inputCommit = null, maxAttempts = 3 }) {
    const run = await getRunById(runId); if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'RUN_NOT_FOUND' });
    const taskId = id('TASK'); const timestamp = now();
    database.run(`INSERT INTO tasks (task_id,run_id,kind,step_id,title,agent_id,state,attempt,max_attempts,route_hash,input_commit,
      task_group_id,task_payload,context_manifest,created_at,updated_at) VALUES (?,?,?,?,?,?,'READY',1,?,?,?,?,?,?,?,?)`,
    [taskId, runId, step.kind, step.step_id, step.title, agentId, maxAttempts, run.routeHash, inputCommit, taskId,
      encode(payload), encode(contextManifest), timestamp, timestamp]);
    return getTask(taskId);
  }
  async function getTask(taskId) { return taskOut(database.get('SELECT * FROM tasks WHERE task_id=?', [taskId])); }
  async function listTasks({ runId = null, states = null, limit = 1000 } = {}) {
    const where = []; const values = [];
    if (runId) { where.push('run_id=?'); values.push(runId); }
    if (states?.length) { where.push(`state IN (${placeholders(states)})`); values.push(...states); }
    values.push(limit); return database.all(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`, values).map(taskOut);
  }
  async function updateTask(taskId, patch) {
    if (patch.state && !TASK_STATES.has(patch.state)) throw Object.assign(new Error(`invalid task state: ${patch.state}`), { code: 'TASK_STATE_INVALID' });
    for (const key of ['jsonRegenerations', 'executionRound']) if (patch[key] !== undefined && (!Number.isInteger(patch[key]) || patch[key] < 0)) {
      throw Object.assign(new Error(`${key} must be a non-negative integer`), { code: 'TASK_COUNTER_INVALID' });
    }
    const columns = { state: ['state', false], attempt: ['attempt', false], maxAttempts: ['max_attempts', false], jsonRegenerations: ['json_regenerations', false],
      executionRound: ['execution_round', false], lastError: ['last_error', true], payload: ['task_payload', true], contextManifest: ['context_manifest', true] };
    const timestamp = now();
    const sets = ['updated_at=?']; const values = [timestamp];
    for (const [key, [column, json]] of Object.entries(columns)) if (patch[key] !== undefined) { sets.push(`${column}=?`); values.push(json ? encode(patch[key]) : patch[key]); }
    values.push(taskId); const result = database.run(`UPDATE tasks SET ${sets.join(',')} WHERE task_id=?`, values);
    if (!result.changes) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
    return getTask(taskId);
  }
  async function updateTaskForExecution(taskId, patch, { executionId, attempt }) {
    if (!executionId || !Number.isInteger(attempt) || attempt < 1) throw new TypeError('executionId and a positive attempt are required');
    if (patch.state && !TASK_STATES.has(patch.state)) throw Object.assign(new Error(`invalid task state: ${patch.state}`), { code: 'TASK_STATE_INVALID' });
    for (const key of ['jsonRegenerations', 'executionRound']) if (patch[key] !== undefined && (!Number.isInteger(patch[key]) || patch[key] < 0)) {
      throw Object.assign(new Error(`${key} must be a non-negative integer`), { code: 'TASK_COUNTER_INVALID' });
    }
    const columns = { state: ['state', false], attempt: ['attempt', false], maxAttempts: ['max_attempts', false], jsonRegenerations: ['json_regenerations', false],
      executionRound: ['execution_round', false], lastError: ['last_error', true], payload: ['task_payload', true], contextManifest: ['context_manifest', true] };
    const timestamp = now();
    const sets = ['updated_at=?']; const values = [timestamp];
    for (const [key, [column, json]] of Object.entries(columns)) if (patch[key] !== undefined) { sets.push(`${column}=?`); values.push(json ? encode(patch[key]) : patch[key]); }
    values.push(taskId, attempt, executionId, attempt, timestamp);
    const result = database.run(`UPDATE tasks SET ${sets.join(',')} WHERE task_id=? AND state='RUNNING' AND attempt=?
      AND EXISTS (SELECT 1 FROM executions WHERE execution_id=? AND task_id=tasks.task_id AND attempt=?
        AND state IN ('LEASED','RUNNING') AND lease_expires_at>=?)`, values);
    if (!result.changes) throw Object.assign(new Error('task execution no longer owns the active task attempt'), { code: 'EXECUTION_TASK_CAS_FAILED', details: {
      task_id: taskId, execution_id: executionId, attempt,
    } });
    return getTask(taskId);
  }
  async function createApproval({ runId, taskId = null, stepId = null, trigger, request }) {
    if (trigger === 'TASK_RETRY_EXHAUSTED') {
      return database.transaction(() => {
        const task = taskOut(database.get('SELECT * FROM tasks WHERE task_id=? AND run_id=?', [taskId, runId]));
        if (!task) throw Object.assign(new Error('retry-exhausted approval task was not found'), { code: 'APPROVAL_TASK_NOT_FOUND' });
        const taskAttempt = request?.task_attempt; const boundMaxAttempts = request?.max_attempts;
        if (!Number.isInteger(taskAttempt) || !Number.isInteger(boundMaxAttempts)) {
          throw Object.assign(new Error('retry-exhausted approval must bind task_attempt and max_attempts'), { code: 'APPROVAL_TASK_BINDING_REQUIRED' });
        }
        const existing = database.all("SELECT * FROM approvals WHERE task_id=? AND trigger='TASK_RETRY_EXHAUSTED' AND status='PENDING' ORDER BY created_at ASC", [taskId])
          .map(approvalOut).find((item) => item.request?.task_attempt === taskAttempt);
        if (existing) return existing;
        if (task.state !== 'FAILED' || task.attempt !== taskAttempt || task.maxAttempts !== boundMaxAttempts) {
          throw Object.assign(new Error('retry-exhausted approval no longer matches the failed task attempt'), { code: 'APPROVAL_TASK_BINDING_STALE' });
        }
        const timestamp = now();
        database.run('INSERT INTO approvals (decision_id,run_id,task_id,step_id,trigger,request,created_at) VALUES (?,?,?,?,?,?,?)',
          [request.decision_id, runId, taskId, stepId, trigger, encode(request), timestamp]);
        const taskResult = database.run("UPDATE tasks SET state='WAITING_HUMAN',updated_at=? WHERE task_id=? AND state='FAILED' AND attempt=? AND max_attempts=?",
          [timestamp, taskId, taskAttempt, boundMaxAttempts]);
        const runResult = database.run("UPDATE runs SET state='WAITING_HUMAN',status_reason=?,updated_at=? WHERE run_id=? AND state='ACTIVE'",
          [request.summary, timestamp, runId]);
        if (!taskResult.changes || !runResult.changes) throw Object.assign(new Error('retry-exhausted approval lost its task or run binding'), { code: 'APPROVAL_TASK_BINDING_STALE' });
        return approvalOut(database.get('SELECT * FROM approvals WHERE decision_id=?', [request.decision_id]));
      });
    }
    database.run('INSERT INTO approvals (decision_id,run_id,task_id,step_id,trigger,request,created_at) VALUES (?,?,?,?,?,?,?)',
      [request.decision_id, runId, taskId, stepId, trigger, encode(request), now()]);
    await updateRun(runId, { state: 'WAITING_HUMAN', statusReason: request.summary });
    if (taskId) await updateTask(taskId, { state: 'WAITING_HUMAN' });
    return approvalOut(database.get('SELECT * FROM approvals WHERE decision_id=?', [request.decision_id]));
  }
  async function resolveApproval({ decisionId, response }) {
    const result = database.run("UPDATE approvals SET status='RESOLVED',response=?,resolved_at=? WHERE decision_id=? AND status='PENDING'", [encode(response), now(), decisionId]);
    if (!result.changes) throw Object.assign(new Error('approval not found or already resolved'), { code: 'APPROVAL_NOT_PENDING' });
    const approval = approvalOut(database.get('SELECT * FROM approvals WHERE decision_id=?', [decisionId]));
    await updateRun(approval.runId, { state: 'ACTIVE', statusReason: 'human decision resolved' });
    if (approval.taskId && response.outcome !== 'REJECTED') await updateTask(approval.taskId, { state: 'SUCCEEDED' });
    return approval;
  }
  async function resolveRetryExhaustedApproval({ decisionId, response }) {
    return database.transaction(() => {
      const approval = approvalOut(database.get("SELECT * FROM approvals WHERE decision_id=? AND status='PENDING'", [decisionId]));
      if (!approval) throw Object.assign(new Error('approval not found or already resolved'), { code: 'APPROVAL_NOT_PENDING' });
      if (approval.trigger !== 'TASK_RETRY_EXHAUSTED' || !approval.taskId) {
        throw Object.assign(new Error('approval is not a task retry exhaustion decision'), { code: 'APPROVAL_TRIGGER_INVALID' });
      }
      const allowed = approval.request?.options?.map((option) => option.option_id).filter(Boolean) ?? [];
      if (!allowed.includes(response.outcome)) throw Object.assign(new Error('approval choice is not allowed'), { code: 'APPROVAL_OPTION_INVALID' });
      const task = taskOut(database.get('SELECT * FROM tasks WHERE task_id=? AND run_id=?', [approval.taskId, approval.runId]));
      const taskAttempt = approval.request?.task_attempt; const boundMaxAttempts = approval.request?.max_attempts;
      if (!task || task.state !== 'WAITING_HUMAN' || task.attempt !== taskAttempt || task.maxAttempts !== boundMaxAttempts) {
        throw Object.assign(new Error('pending approval no longer matches the waiting task attempt'), { code: 'APPROVAL_TASK_BINDING_STALE' });
      }
      const run = runOut(database.get('SELECT * FROM runs WHERE run_id=?', [approval.runId]));
      if (!run || run.state !== 'WAITING_HUMAN') throw Object.assign(new Error('pending approval no longer matches the waiting run'), { code: 'APPROVAL_RUN_BINDING_STALE' });
      const timestamp = now();
      const resolved = database.run("UPDATE approvals SET status='RESOLVED',response=?,resolved_at=? WHERE decision_id=? AND status='PENDING'",
        [encode(response), timestamp, decisionId]);
      const abort = ['ABORT', 'CANCEL', 'REJECTED'].includes(response.outcome);
      const payload = { ...(task.payload ?? {}), retry_authorization: { decision_id: decisionId, choice: response.outcome,
        notes: response.notes ?? '', actor: response.actor, exhausted: true } };
      const taskResult = database.run(`UPDATE tasks SET state=?,attempt=?,max_attempts=?,json_regenerations=0,execution_round=?,
        context_manifest=?,task_payload=?,updated_at=? WHERE task_id=? AND state='WAITING_HUMAN' AND attempt=? AND max_attempts=?`,
      [abort ? 'CANCELLED' : 'READY', abort ? task.attempt : task.attempt + 1, abort ? task.maxAttempts : task.maxAttempts + 3,
        abort ? task.executionRound : task.executionRound + 1, encode(abort ? task.contextManifest : {}), encode(payload), timestamp,
        task.taskId, taskAttempt, boundMaxAttempts]);
      const runResult = abort
        ? database.run("UPDATE runs SET state='TERMINAL',outcome='CANCELLED',status_reason='user declined an exhausted retry approval',completed_at=?,updated_at=? WHERE run_id=? AND state='WAITING_HUMAN'",
          [timestamp, timestamp, run.runId])
        : database.run("UPDATE runs SET state='ACTIVE',status_reason='user approved a new retry batch',updated_at=? WHERE run_id=? AND state='WAITING_HUMAN'",
          [timestamp, run.runId]);
      if (!resolved.changes || !taskResult.changes || !runResult.changes) {
        throw Object.assign(new Error('retry approval transaction lost its task or run binding'), { code: 'APPROVAL_TASK_BINDING_STALE' });
      }
      return { approval: approvalOut(database.get('SELECT * FROM approvals WHERE decision_id=?', [decisionId])),
        task: taskOut(database.get('SELECT * FROM tasks WHERE task_id=?', [task.taskId])),
        run: runOut(database.get('SELECT * FROM runs WHERE run_id=?', [run.runId])) };
    });
  }
  async function listApprovals({ runId = null, status = null } = {}) {
    const where = []; const values = []; if (runId) { where.push('run_id=?'); values.push(runId); } if (status) { where.push('status=?'); values.push(status); }
    return database.all(`SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`, values).map(approvalOut);
  }
  async function queueNotification({ runId, taskId = null, type, payload }) {
    const notificationId = id('NTF'); database.run('INSERT INTO notifications (notification_id,run_id,task_id,type,payload,created_at) VALUES (?,?,?,?,?,?)',
      [notificationId, runId, taskId, type, encode(payload), now()]);
    return notificationOut(database.get('SELECT * FROM notifications WHERE notification_id=?', [notificationId]));
  }
  async function listNotifications({ runId = null, statuses = ['PENDING', 'FAILED'], limit = 100 } = {}) {
    const where = []; const values = []; if (statuses?.length) { where.push(`status IN (${placeholders(statuses)})`); values.push(...statuses); }
    if (runId) { where.push('run_id=?'); values.push(runId); } values.push(limit);
    return database.all(`SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`, values).map(notificationOut);
  }
  async function updateNotification(notificationId, patch) {
    const item = notificationOut(database.get('SELECT * FROM notifications WHERE notification_id=?', [notificationId])); if (!item) return null;
    const status = patch.status ?? item.status; const timestamp = now();
    database.run(`UPDATE notifications SET status=?,attempts=attempts+?,last_error=?,sent_at=?,delivered_at=? WHERE notification_id=?`,
      [status, patch.incrementAttempts ? 1 : 0, encode(patch.lastError), ['SENT','DELIVERED'].includes(status) ? timestamp : item.sentAt,
        status === 'DELIVERED' ? timestamp : item.deliveredAt, notificationId]);
    return notificationOut(database.get('SELECT * FROM notifications WHERE notification_id=?', [notificationId]));
  }
  async function queueHrJob({ reviewKey, triggerMode = 'MANUAL', runId = null, taskId = null, kind = 'SESSION_REVIEW', sourceAgentId = null, sourceSessionId = null, input }) {
    if (!reviewKey) throw Object.assign(new Error('reviewKey is required'), { code: 'HR_REVIEW_KEY_REQUIRED' });
    if (!HR_KINDS.has(kind) || !HR_TRIGGERS.has(triggerMode)) throw Object.assign(new Error('invalid HR job kind or trigger'), { code: 'HR_JOB_INVALID' });
    const existing = hrJobOut(database.get('SELECT * FROM hr_jobs WHERE review_key=?', [reviewKey])); if (existing) return existing;
    const jobId = id('HRJ'); database.run(`INSERT INTO hr_jobs (job_id,review_key,run_id,task_id,kind,trigger_mode,source_agent_id,source_session_id,input,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [jobId, reviewKey, runId, taskId, kind, triggerMode, sourceAgentId, sourceSessionId, encode(input ?? {}), now()]);
    return hrJobOut(database.get('SELECT * FROM hr_jobs WHERE job_id=?', [jobId]));
  }
  async function listHrJobs({ runId = null, taskId = null, statuses = null, limit = 100 } = {}) {
    const where = []; const values = []; if (runId) { where.push('run_id=?'); values.push(runId); } if (taskId) { where.push('task_id=?'); values.push(taskId); }
    if (statuses?.length) { where.push(`status IN (${placeholders(statuses)})`); values.push(...statuses); } values.push(limit);
    return database.all(`SELECT * FROM hr_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, values).map(hrJobOut);
  }
  async function updateHrJob(jobId, patch) {
    const item = hrJobOut(database.get('SELECT * FROM hr_jobs WHERE job_id=?', [jobId])); if (!item) return null;
    const status = patch.status ?? item.status; const timestamp = now();
    database.run(`UPDATE hr_jobs SET status=?,hr_session_id=?,attempts=attempts+?,last_error=?,result=?,started_at=?,finished_at=? WHERE job_id=?`,
      [status, patch.hrSessionId ?? item.hrSessionId, patch.incrementAttempts ? 1 : 0, encode(patch.lastError), patch.result === undefined ? encode(item.result) : encode(patch.result),
        status === 'RUNNING' ? timestamp : item.startedAt, ['SUCCEEDED','FAILED'].includes(status) ? timestamp : item.finishedAt, jobId]);
    return hrJobOut(database.get('SELECT * FROM hr_jobs WHERE job_id=?', [jobId]));
  }
  async function registerArtifact({ runId, taskId, executionId = null, kind, uri, sha256: digest, sizeBytes, mediaType, commitSha = null }) {
    const artifactId = artifactIdFor(runId); database.run(`INSERT INTO artifacts (artifact_id,run_id,task_id,execution_id,kind,uri,sha256,size_bytes,media_type,commit_sha,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [artifactId, runId, taskId, executionId, kind, uri, digest, sizeBytes, mediaType ?? 'application/json', commitSha, now()]);
    return database.get('SELECT * FROM artifacts WHERE artifact_id=?', [artifactId]);
  }
  async function createSnapshot(snapshot) {
    if (!SNAPSHOT_KINDS.has(snapshot.snapshotKind)) throw Object.assign(new Error(`invalid snapshot kind: ${snapshot.snapshotKind}`), { code: 'SNAPSHOT_KIND_INVALID' });
    database.run(`INSERT INTO snapshots (snapshot_id,run_id,task_id,execution_id,attempt,agent_id,session_id,input_commit,output_commit,parent_snapshot_id,
      git_ref,snapshot_kind,change_summary,worktree_path_abs,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [snapshot.snapshotId, snapshot.runId, snapshot.taskId, snapshot.executionId ?? null, snapshot.attempt, snapshot.agentId, snapshot.sessionId ?? null,
      snapshot.inputCommit, snapshot.outputCommit, snapshot.parentSnapshotId ?? null, snapshot.gitRef, snapshot.snapshotKind,
      encode(snapshot.changeSummary ?? {}), snapshot.worktreePathAbs, now()]);
    return getSnapshot(snapshot.snapshotId);
  }
  async function getSnapshot(snapshotId) { return snapshotOut(database.get('SELECT * FROM snapshots WHERE snapshot_id=?', [snapshotId])); }
  async function listSnapshots({ runId = null, taskId = null, agentId = null, sessionId = null, limit = 500 } = {}) {
    const where = []; const values = []; for (const [column, value] of [['run_id',runId],['task_id',taskId],['agent_id',agentId],['session_id',sessionId]]) if (value) { where.push(`${column}=?`); values.push(value); }
    values.push(limit); return database.all(`SELECT * FROM snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, values).map(snapshotOut);
  }
  return { createRun, getRun, getRunById, listRuns, updateRun, createTask, getTask, listTasks, updateTask, updateTaskForExecution,
    createApproval, resolveApproval, resolveRetryExhaustedApproval, listApprovals, queueNotification, listNotifications, updateNotification,
    queueHrJob, listHrJobs, updateHrJob, registerArtifact, createSnapshot, getSnapshot, listSnapshots,
    executionIdFor, now };
}
