import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../runtime-core/atomic-store.mjs';
import { redactValue } from '../../monitor/redactor.mjs';
import { inspectAssistantText, DEFAULT_HR_KEYWORDS } from './keywords.mjs';
import { buildSessionDossier } from './session-dossier.mjs';
import { runOpenClawAgent } from '../orchestrator/openclaw-runner.mjs';

const AUTO_MODES = new Set(['off', 'task', 'daily', 'both']);
function jobSession(job) { return `hr-${job.jobId.toLowerCase()}`.slice(0, 120); }
function readEnvironmentFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim(); if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('='); if (separator <= 0) continue;
    let value = line.slice(separator + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}
function boolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(true|1|yes|on)$/iu.test(value)) return true;
  if (/^(false|0|no|off)$/iu.test(value)) return false;
  throw Object.assign(new Error(`invalid boolean value: ${value}`), { code: 'HR_ENABLED_INVALID' });
}
export function resolveHrEnabled(projectRootInput = process.cwd(), environment = process.env) {
  const projectRoot = resolve(projectRootInput); const local = readEnvironmentFile(join(projectRoot, '.env'));
  return boolean(environment.OPENCLAW_HR_ENABLED ?? local.OPENCLAW_HR_ENABLED, true);
}
export function resolveHrAutoMode(projectRootInput = process.cwd(), environment = process.env) {
  const projectRoot = resolve(projectRootInput); const local = readEnvironmentFile(join(projectRoot, '.env'));
  const mode = String(environment.OPENCLAW_HR_AUTO_MODE ?? local.OPENCLAW_HR_AUTO_MODE ?? 'off').toLowerCase();
  if (!AUTO_MODES.has(mode)) throw Object.assign(new Error(`invalid OPENCLAW_HR_AUTO_MODE value: ${mode}`), { code: 'HR_AUTO_MODE_INVALID' });
  return mode;
}
function defaultSessionRoot(projectRoot) { return resolve(process.env.OPENCLAW_SESSION_ROOT ?? join(process.env.USERPROFILE ?? process.env.HOME ?? projectRoot, '.openclaw', 'agents')); }

function messageFor(job) {
  return `# HR Session boundary review\n\nYou are a protected, read-only reviewer. Review exactly the supplied redacted dossier. Check only these categories:\n\n- UNAUTHORIZED_ACTION: action or modification beyond the assigned role/task boundary.\n- UNCLEAR_BOUNDARY: assumptions, limitations, incomplete work, or ownership boundaries were not stated clearly.\n- SPECULATIVE_OR_VAGUE: reasoning or final claims substitute guesses or vague language for verifiable evidence.\n\nReturn a concise JSON object with a findings array. Each finding must contain category, severity, evidence_locator, shortest_redacted_excerpt, explanation, and recommendation. Do not reproduce private reasoning beyond the shortest necessary redacted excerpt. Do not contact the user, mutate workflow state, approve work, invoke Agents, or use information outside this dossier.\n\n${JSON.stringify(job.input, null, 2)}\n`;
}

export function createHrService({ projectRoot: projectRootInput, repository, snapshots = null, sessionRoot = null,
  dossierBuilder = buildSessionDossier, runner = runOpenClawAgent, keywords = DEFAULT_HR_KEYWORDS,
  enabled = undefined, autoMode = undefined } = {}) {
  if (!repository) throw new TypeError('repository is required');
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const hrEnabled = enabled ?? resolveHrEnabled(projectRoot); const selectedAutoMode = autoMode ?? resolveHrAutoMode(projectRoot);
  const selectedSessionRoot = resolve(sessionRoot ?? defaultSessionRoot(projectRoot));

  async function queueReview({ workflowId = null, taskId = null, date = null, triggerMode = 'MANUAL' } = {}) {
    if (!hrEnabled) return [];
    if (!snapshots) throw Object.assign(new Error('snapshot service is required for HR review'), { code: 'HR_SNAPSHOTS_REQUIRED' });
    let runId = null; if (workflowId) { const run = await repository.getRun(workflowId); if (!run) throw Object.assign(new Error(`workflow not found: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' }); runId = run.runId; }
    let candidates = await snapshots.list({ runId, taskId, limit: 10000 });
    if (date) candidates = candidates.filter((item) => String(item.createdAt ?? '').startsWith(date));
    candidates = candidates.filter((item) => item.agentId !== 'hr-agent' && item.sessionId);
    const existing = new Set((await repository.listHrJobs({ limit: 10000 })).map((job) => job.reviewKey)); const queued = [];
    for (const snapshot of candidates) {
      const reviewKey = `${triggerMode}:${snapshot.snapshotId}:${snapshot.sessionId}`; if (existing.has(reviewKey)) continue;
      const diff = await snapshots.diff(snapshot.snapshotId);
      const dossier = dossierBuilder({ sessionRoot: selectedSessionRoot, agentId: snapshot.agentId, sessionId: snapshot.sessionId,
        snapshot, patch: diff.patch });
      queued.push(await repository.queueHrJob({ reviewKey, triggerMode, runId: snapshot.runId, taskId: snapshot.taskId,
        kind: 'SESSION_REVIEW', sourceAgentId: snapshot.agentId, sourceSessionId: snapshot.sessionId, input: dossier }));
      existing.add(reviewKey);
    }
    return queued;
  }
  async function queueTaskDailyReport({ task }) {
    if (!hrEnabled || !['task', 'both'].includes(selectedAutoMode)) return null;
    return queueReview({ taskId: task.taskId, triggerMode: 'AUTO_TASK' });
  }
  async function queueDailyReview(date, { manual = false } = {}) {
    if (!hrEnabled || (!manual && !['daily', 'both'].includes(selectedAutoMode))) return [];
    return queueReview({ date, triggerMode: manual ? 'MANUAL' : 'AUTO_DAILY' });
  }
  async function recordAssistantOutput({ agentId, text }) {
    if (!hrEnabled || agentId === 'hr-agent') return { matches: [], job: null, alert: null };
    return { matches: inspectAssistantText(redactValue(String(text ?? '')), keywords), job: null, alert: null };
  }
  async function runPending({ limit = 20 } = {}) {
    if (!hrEnabled) return [];
    const jobs = await repository.listHrJobs({ statuses: ['PENDING', 'FAILED'], limit }); const results = [];
    for (const job of jobs) {
      const sessionId = job.hrSessionId ?? jobSession(job);
      await repository.updateHrJob(job.jobId, { status: 'RUNNING', hrSessionId: sessionId, incrementAttempts: true });
      const root = join(projectRoot, 'runtime', 'hr', job.jobId); mkdirSync(root, { recursive: true });
      const messagePath = join(root, 'message.md'); atomicWriteFile(messagePath, messageFor(job));
      try {
        const result = await runner({ agentId: 'hr-agent', sessionId, messagePath, timeoutSeconds: 600, thinking: 'off' });
        if (result.exitCode !== 0) throw Object.assign(new Error(`HR Agent exited with ${result.exitCode}`), { code: 'HR_AGENT_EXIT_NONZERO' });
        results.push(await repository.updateHrJob(job.jobId, { status: 'SUCCEEDED', hrSessionId: sessionId,
          result: { session_id: sessionId, output: redactValue(String(result.stdout ?? ''), { maxStringLength: 12000 }) } }));
      } catch (error) {
        results.push(await repository.updateHrJob(job.jobId, { status: 'FAILED', hrSessionId: sessionId,
          lastError: { code: error.code ?? 'HR_AGENT_FAILED', message: error.message } }));
      }
    }
    return results;
  }
  return { projectRoot, sessionRoot: selectedSessionRoot, enabled: hrEnabled, autoMode: selectedAutoMode, recordAssistantOutput,
    queueReview, queueTaskDailyReport, queueDailyReview, runPending, keywords };
}
