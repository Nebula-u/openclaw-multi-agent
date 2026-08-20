import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../runtime-core/atomic-store.mjs';
import { redactValue } from '../../monitor/redactor.mjs';
import { inspectAssistantText, DEFAULT_HR_KEYWORDS } from './keywords.mjs';
import { runOpenClawAgent } from '../orchestrator/openclaw-runner.mjs';

function jobSession(job) { return `hr-${job.jobId.toLowerCase()}`.slice(0, 120); }

function readEnvironmentFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

export function resolveHrEnabled(projectRootInput = process.cwd()) {
  const projectRoot = resolve(projectRootInput);
  const value = process.env.OPENCLAW_HR_ENABLED ?? readEnvironmentFile(join(projectRoot, '.env')).OPENCLAW_HR_ENABLED;
  if (value === undefined || value === '') return true;
  if (/^(true|1|yes|on)$/iu.test(value)) return true;
  if (/^(false|0|no|off)$/iu.test(value)) return false;
  throw Object.assign(new Error(`invalid OPENCLAW_HR_ENABLED value: ${value}`), { code: 'HR_ENABLED_INVALID' });
}

function messageFor(job) {
  if (job.kind === 'TASK_DAILY_REPORT') {
    return `# HR task daily report\n\nYou are a background reviewer. Do not contact the user and do not change workflow state. Read only the supplied redacted facts and the visible Agent sessions. Return a plain-language report in this session covering: what each Agent did, errors or limitations, and items needing attention.\n\n${JSON.stringify(job.input, null, 2)}\n`;
  }
  return `# HR assistant-output review\n\nYou are a background reviewer. Do not contact the user and do not change workflow state. Review only this redacted assistant-visible text. Explain the uncertainty or risk indicated by the flagged words and quote only the supplied context.\n\n${JSON.stringify(job.input, null, 2)}\n`;
}

export function createHrService({ projectRoot: projectRootInput, repository, kernel, runner = runOpenClawAgent, keywords = DEFAULT_HR_KEYWORDS, clock = () => new Date(), enabled = undefined } = {}) {
  if (!repository) throw new TypeError('repository is required');
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const hrEnabled = enabled ?? resolveHrEnabled(projectRoot);

  async function recordAssistantOutput({ runId = null, taskId = null, agentId, sessionId, sourceEventId = null, text, timestamp = null }) {
    if (!hrEnabled || agentId === 'hr-agent') return { matches: [], job: null, alert: null };
    const safeText = redactValue(String(text ?? ''));
    const matches = inspectAssistantText(safeText, keywords);
    let alert = null;
    if (matches.length && runId && kernel?.appendEvent) {
      alert = await kernel.appendEvent({ runId, taskId, type: 'HR_KEYWORD_ALERT', key: 'hr', change: 'HR_KEYWORD_ALERT', detail: {
        agent_id: agentId, session_id: sessionId, source_event_id: sourceEventId, matches, text: safeText, timestamp,
      } });
    }
    const job = await repository.queueHrJob({ runId, taskId, kind: 'OUTPUT_REVIEW', sourceAgentId: agentId, sourceSessionId: sessionId,
      sourceEventId, input: { text: safeText, matches, timestamp } });
    return { matches, alert, job, alertPayload: matches.length ? { agent_id: agentId, session_id: sessionId, source_event_id: sourceEventId, matches, text: safeText, timestamp, run_id: runId, task_id: taskId } : null };
  }

  async function queueTaskDailyReport({ run, task, outcome, events = [] }) {
    if (!hrEnabled) return null;
    return repository.queueHrJob({ runId: run.runId, taskId: task.taskId, kind: 'TASK_DAILY_REPORT', sourceAgentId: task.agentId,
      sourceSessionId: task.payload?.session_id ?? null, input: {
        workflow_id: run.workflowId, task_id: task.taskId, task_kind: task.kind, agent_id: task.agentId, task_state: task.state,
        outcome: outcome ?? task.payload?.result?.result_status ?? null, summary_for_user: task.payload?.result?.summary_for_user ?? null,
        summary_for_manager: task.payload?.result?.summary_for_manager ?? null, manager_session_id: run.managerSessionId,
        agent_session_id: task.payload?.session_id ?? null, kernel_events: events,
      } });
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
        const result = await runner({ agentId: 'hr-agent', sessionId, messagePath, timeoutSeconds: 600 });
        if (result.exitCode !== 0) throw Object.assign(new Error(`HR Agent exited with ${result.exitCode}`), { code: 'HR_AGENT_EXIT_NONZERO' });
        results.push(await repository.updateHrJob(job.jobId, { status: 'SUCCEEDED', hrSessionId: sessionId }));
      } catch (error) {
        results.push(await repository.updateHrJob(job.jobId, { status: 'FAILED', hrSessionId: sessionId, lastError: { code: error.code ?? 'HR_AGENT_FAILED', message: error.message } }));
      }
    }
    return results;
  }

  return { projectRoot, enabled: hrEnabled, recordAssistantOutput, queueTaskDailyReport, runPending, keywords };
}
