import { randomUUID } from 'node:crypto';
import { artifactIdFor, executionIdFor, newRunId } from './ids.mjs';
import { sha256 } from '../runtime-core/hash-chain.mjs';

const RUN_STATES = new Set(['ACTIVE', 'WAITING_HUMAN', 'HOLD', 'TERMINAL']);
const TASK_STATES = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_HUMAN', 'CANCELLED']);

function id(prefix) { return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 20)}`; }
function json(value) { return JSON.stringify(value ?? {}); }
function time(value) { return value instanceof Date ? value.toISOString() : value; }

function runOut(row) {
  if (!row) return null;
  return {
    runId: row.run_id, workflowId: row.workflow_id, state: row.state, outcome: row.outcome,
    statusReason: row.status_reason, request: row.request, routePlan: row.route_plan,
    currentStepIndex: row.current_step_index, revision: row.revision,
    targetProjectRootAbs: row.target_project_root_abs, baseCommit: row.base_commit,
    candidateCommit: row.candidate_commit, routeHash: row.route_hash,
    managerSessionId: row.manager_session_id, managerSessionKey: row.manager_session_key,
    managerDelivery: row.manager_delivery, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function taskOut(row) {
  if (!row) return null;
  return {
    taskId: row.task_id, runId: row.run_id, kind: row.kind, stepId: row.step_id,
    title: row.title, agentId: row.agent_id, state: row.state, status: row.state,
    attempt: row.attempt, maxAttempts: row.max_attempts, inputCommit: row.input_commit,
    routeHash: row.route_hash, lastError: row.last_error, payload: row.task_payload,
    contextManifest: row.context_manifest, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function approvalOut(row) {
  if (!row) return null;
  return { decisionId: row.decision_id, runId: row.run_id, taskId: row.task_id, stepId: row.step_id,
    trigger: row.trigger, request: row.request, response: row.response, status: row.status,
    createdAt: row.created_at, resolvedAt: row.resolved_at };
}

function notificationOut(row) {
  if (!row) return null;
  return { notificationId: row.notification_id, runId: row.run_id, taskId: row.task_id,
    type: row.type, payload: row.payload, status: row.status, attempts: row.attempts,
    lastError: row.last_error, createdAt: row.created_at, sentAt: row.sent_at, deliveredAt: row.delivered_at };
}

function hrJobOut(row) {
  if (!row) return null;
  return { jobId: row.job_id, runId: row.run_id, taskId: row.task_id, kind: row.kind,
    sourceAgentId: row.source_agent_id, sourceSessionId: row.source_session_id,
    sourceEventId: row.source_event_id, input: row.input, hrSessionId: row.hr_session_id,
    status: row.status, attempts: row.attempts, lastError: row.last_error, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at };
}

export function createWorkflowRepository({ pool, kernel, clock = () => new Date() }) {
  async function append(runId, type, payload, extra = {}) {
    if (!kernel?.appendEvent) return null;
    return kernel.appendEvent({ runId, taskId: extra.taskId ?? null, executionId: extra.executionId ?? null,
      type, key: 'orchestrator', change: type, cause: extra.cause, detail: payload,
      idempotencyKey: extra.idempotencyKey ?? null });
  }

  async function createRun({ workflowId, request, routePlan, targetProjectRootAbs, baseCommit = 'UNKNOWN',
    managerSessionId, managerSessionKey, managerDelivery = null }) {
    const runId = newRunId();
    const routeHash = routePlan?.route_hash ?? sha256(routePlan ?? {});
    const requestHash = sha256(request ?? {});
    const { rows } = await pool.query(
      `INSERT INTO runs (run_id, langgraph_thread_id, workflow_id, state, request, request_sha256,
        route_plan, current_step_index, revision, target_project_root_abs, base_commit, route_hash,
        manager_session_id, manager_session_key, manager_delivery)
       VALUES ($1,$2,$2,'ACTIVE',$3,$4,$5,0,1,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [runId, workflowId, json(request), requestHash, json(routePlan), targetProjectRootAbs, baseCommit,
        routeHash, managerSessionId ?? null, managerSessionKey ?? null, managerDelivery ? json(managerDelivery) : null],
    );
    const run = runOut(rows[0]);
    await append(run.runId, 'ROUTE_CONFIRMED', { workflow_id: workflowId, route_hash: routeHash, route_plan: routePlan });
    return run;
  }

  async function getRun(workflowId) {
    const { rows } = await pool.query('SELECT * FROM runs WHERE workflow_id=$1', [workflowId]);
    return runOut(rows[0]);
  }

  async function getRunById(runId) {
    const { rows } = await pool.query('SELECT * FROM runs WHERE run_id=$1', [runId]);
    return runOut(rows[0]);
  }

  async function listRuns({ limit = 200 } = {}) {
    const { rows } = await pool.query('SELECT * FROM runs ORDER BY updated_at DESC LIMIT $1', [limit]);
    return rows.map(runOut);
  }

  async function updateRun(runId, patch, { expectedRevision = null, eventType = 'RUN_UPDATED', eventPayload = patch } = {}) {
    if (patch.state && !RUN_STATES.has(patch.state)) throw Object.assign(new Error(`invalid run state: ${patch.state}`), { code: 'RUN_STATE_INVALID' });
    const values = []; const sets = ['updated_at=now()', 'revision=revision+1'];
    const add = (column, value, stringify = false) => { if (value !== undefined) { values.push(stringify ? json(value) : value); sets.push(`${column}=$${values.length}`); } };
    add('state', patch.state); add('outcome', patch.outcome); add('status_reason', patch.statusReason);
    add('current_step_index', patch.currentStepIndex); add('candidate_commit', patch.candidateCommit);
    add('route_plan', patch.routePlan, true); add('route_hash', patch.routeHash);
    if (patch.completedAt !== undefined) { values.push(patch.completedAt); sets.push(`completed_at=$${values.length}`); }
    values.push(runId);
    let where = `run_id=$${values.length}`;
    if (expectedRevision !== null) { values.push(expectedRevision); where += ` AND revision=$${values.length}`; }
    const { rows } = await pool.query(`UPDATE runs SET ${sets.join(', ')} WHERE ${where} RETURNING *`, values);
    if (rows.length === 0) throw Object.assign(new Error('run does not exist or revision is stale'), { code: 'RUN_CAS_CONFLICT' });
    const run = runOut(rows[0]);
    await append(runId, eventType, eventPayload);
    return run;
  }

  async function createTask({ runId, step, agentId, payload = {}, contextManifest = null, inputCommit = null, maxAttempts = 3 }) {
    const taskId = id('TASK');
    const { rows } = await pool.query(
      `INSERT INTO tasks (task_id, run_id, kind, step_id, title, agent_id, state, attempt, max_attempts,
        route_hash, input_commit, task_group_id, task_payload, context_manifest)
       SELECT $1, run_id, $3, $4, $5, $6, 'READY', 1, $7, route_hash, $8, $1, $9, $10
       FROM runs WHERE run_id=$2 RETURNING *`,
      [taskId, runId, step.kind, step.step_id, step.title, agentId, maxAttempts, inputCommit,
        json(payload), contextManifest ? json(contextManifest) : null],
    );
    if (!rows.length) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'RUN_NOT_FOUND' });
    const task = taskOut(rows[0]);
    await append(runId, 'TASK_READY', { task_id: taskId, step_id: step.step_id, agent_id: agentId }, { taskId });
    return task;
  }

  async function getTask(taskId) {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE task_id=$1', [taskId]);
    return taskOut(rows[0]);
  }

  async function listTasks({ runId = null, states = null, limit = 1000 } = {}) {
    const params = []; const where = [];
    if (runId) { params.push(runId); where.push(`run_id=$${params.length}`); }
    if (states?.length) { params.push(states); where.push(`state=ANY($${params.length})`); }
    params.push(limit);
    const { rows } = await pool.query(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return rows.map(taskOut);
  }

  async function updateTask(taskId, patch, { eventType = 'TASK_UPDATED', eventPayload = patch } = {}) {
    if (patch.state && !TASK_STATES.has(patch.state)) throw Object.assign(new Error(`invalid task state: ${patch.state}`), { code: 'TASK_STATE_INVALID' });
    const values = []; const sets = ['updated_at=now()'];
    const add = (column, value, stringify = false) => { if (value !== undefined) { values.push(stringify ? json(value) : value); sets.push(`${column}=$${values.length}`); } };
    add('state', patch.state); add('attempt', patch.attempt); add('last_error', patch.lastError, true);
    add('task_payload', patch.payload, true); add('context_manifest', patch.contextManifest, true);
    values.push(taskId);
    const { rows } = await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id=$${values.length} RETURNING *`, values);
    const task = taskOut(rows[0]);
    if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'TASK_NOT_FOUND' });
    await append(task.runId, eventType, eventPayload, { taskId });
    return task;
  }

  async function createApproval({ runId, taskId = null, stepId = null, trigger, request }) {
    const { rows } = await pool.query(
      `INSERT INTO approvals (decision_id, run_id, task_id, step_id, trigger, request)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.decision_id, runId, taskId, stepId, trigger, json(request)],
    );
    await updateRun(runId, { state: 'WAITING_HUMAN', statusReason: request.summary }, { eventType: 'WAITING_HUMAN', eventPayload: { decision_id: request.decision_id }, expectedRevision: null });
    if (taskId) await updateTask(taskId, { state: 'WAITING_HUMAN' }, { eventType: 'TASK_WAITING_HUMAN', eventPayload: { decision_id: request.decision_id } });
    return approvalOut(rows[0]);
  }

  async function resolveApproval({ decisionId, response }) {
    const { rows } = await pool.query(
      `UPDATE approvals SET status='RESOLVED', response=$2, resolved_at=now()
       WHERE decision_id=$1 AND status='PENDING' RETURNING *`, [decisionId, json(response)],
    );
    const approval = approvalOut(rows[0]);
    if (!approval) throw Object.assign(new Error('approval not found or already resolved'), { code: 'APPROVAL_NOT_PENDING' });
    await updateRun(approval.runId, { state: 'ACTIVE', statusReason: 'human decision resolved' }, { eventType: 'APPROVAL_RESOLVED', eventPayload: { decision_id: decisionId, outcome: response.outcome } });
    if (approval.taskId && response.outcome !== 'REJECTED') await updateTask(approval.taskId, { state: 'SUCCEEDED' }, { eventType: 'TASK_APPROVED', eventPayload: { decision_id: decisionId } });
    return approval;
  }

  async function listApprovals({ runId = null, status = null } = {}) {
    const params = []; const where = [];
    if (runId) { params.push(runId); where.push(`run_id=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    const { rows } = await pool.query(`SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`, params);
    return rows.map(approvalOut);
  }

  async function queueNotification({ runId, taskId = null, type, payload }) {
    const notificationId = id('NTF');
    const { rows } = await pool.query(
      `INSERT INTO notifications (notification_id, run_id, task_id, type, payload)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [notificationId, runId, taskId, type, json(payload)],
    );
    await append(runId, 'MANAGER_NOTIFICATION_QUEUED', { notification_id: notificationId, type }, { taskId });
    return notificationOut(rows[0]);
  }

  async function listNotifications({ runId = null, statuses = ['PENDING', 'FAILED'], limit = 100 } = {}) {
    const params = [statuses]; const where = ['status=ANY($1)'];
    if (runId) { params.push(runId); where.push(`run_id=$${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return rows.map(notificationOut);
  }

  async function updateNotification(notificationId, patch) {
    const { rows } = await pool.query(
      `UPDATE notifications SET status=COALESCE($2,status), attempts=attempts+$3, last_error=$4,
        sent_at=CASE WHEN $2 IN ('SENT','DELIVERED') THEN now() ELSE sent_at END,
        delivered_at=CASE WHEN $2='DELIVERED' THEN now() ELSE delivered_at END
       WHERE notification_id=$1 RETURNING *`,
      [notificationId, patch.status ?? null, patch.incrementAttempts ? 1 : 0, patch.lastError ? json(patch.lastError) : null],
    );
    const notification = notificationOut(rows[0]);
    if (!notification) return null;
    if (patch.status) {
      await append(notification.runId, patch.status === 'DELIVERED' ? 'MANAGER_NOTIFICATION_DELIVERED' : 'MANAGER_NOTIFICATION_FAILED', {
        notification_id: notificationId, status: patch.status, error: patch.lastError ?? null,
      }, { taskId: notification.taskId });
    }
    return notification;
  }

  async function queueHrJob({ runId = null, taskId = null, kind, sourceAgentId = null, sourceSessionId = null, sourceEventId = null, input }) {
    const jobId = id('HRJ');
    const { rows } = await pool.query(
      `INSERT INTO hr_jobs (job_id, run_id, task_id, kind, source_agent_id, source_session_id, source_event_id, input)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [jobId, runId, taskId, kind, sourceAgentId, sourceSessionId, sourceEventId, json(input)],
    );
    if (runId) await append(runId, 'HR_JOB_QUEUED', { job_id: jobId, kind }, { taskId });
    return hrJobOut(rows[0]);
  }

  async function listHrJobs({ runId = null, taskId = null, statuses = null, limit = 100 } = {}) {
    const params = []; const where = [];
    if (runId) { params.push(runId); where.push(`run_id=$${params.length}`); }
    if (taskId) { params.push(taskId); where.push(`task_id=$${params.length}`); }
    if (statuses?.length) { params.push(statuses); where.push(`status=ANY($${params.length})`); }
    params.push(limit);
    const { rows } = await pool.query(`SELECT * FROM hr_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(hrJobOut);
  }

  async function updateHrJob(jobId, patch) {
    const { rows } = await pool.query(
      `UPDATE hr_jobs SET status=COALESCE($2,status), hr_session_id=COALESCE($3,hr_session_id),
        attempts=attempts+$4, last_error=$5,
        started_at=CASE WHEN $2='RUNNING' THEN now() ELSE started_at END,
        finished_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED') THEN now() ELSE finished_at END
       WHERE job_id=$1 RETURNING *`,
      [jobId, patch.status ?? null, patch.hrSessionId ?? null, patch.incrementAttempts ? 1 : 0, patch.lastError ? json(patch.lastError) : null],
    );
    const job = hrJobOut(rows[0]);
    if (!job) return null;
    if (patch.status && job.runId) await append(job.runId, patch.status === 'SUCCEEDED' ? 'HR_JOB_SUCCEEDED' : patch.status === 'FAILED' ? 'HR_JOB_FAILED' : 'HR_JOB_STARTED', {
      job_id: jobId, kind: job.kind, status: patch.status, error: patch.lastError ?? null,
    }, { taskId: job.taskId });
    return job;
  }

  async function registerArtifact({ runId, taskId, executionId = null, kind, uri, sha256: digest, sizeBytes, mediaType, commitSha = null }) {
    const artifactId = artifactIdFor(runId);
    const { rows } = await pool.query(
      `INSERT INTO artifacts (artifact_id, run_id, task_id, execution_id, kind, uri, sha256, size_bytes, media_type, commit_sha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [artifactId, runId, taskId, executionId, kind, uri, digest, sizeBytes, mediaType ?? 'application/json', commitSha],
    );
    await append(runId, 'ARTIFACT_REGISTERED', { artifact_id: artifactId, kind, uri }, { taskId, executionId });
    return rows[0];
  }

  return {
    createRun, getRun, getRunById, listRuns, updateRun, createTask, getTask, listTasks, updateTask,
    createApproval, resolveApproval, listApprovals, queueNotification, listNotifications,
    updateNotification, queueHrJob, listHrJobs, updateHrJob, registerArtifact,
    executionIdFor, now: () => time(clock()),
  };
}
