import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from '../runtime-core/atomic-store.mjs';
import { redactValue } from '../../monitor/redactor.mjs';
import { inspectAssistantText, DEFAULT_HR_KEYWORDS } from './keywords.mjs';
import { runOpenClawAgent } from '../orchestrator/openclaw-runner.mjs';

function jobSession(job) { return `hr-${job.jobId.toLowerCase()}`.slice(0, 120); }
function messageFor(job) {
  if (job.kind === 'TASK_DAILY_REPORT') {
    return `# HR task daily report\n\nYou are a background reviewer. Do not contact the user and do not change workflow state. Read only the supplied redacted facts and the visible Agent sessions. Return a plain-language report in this session covering: what each Agent did, errors or limitations, and items needing attention.\n\n${JSON.stringify(job.input, null, 2)}\n`;
  }
  return `# HR assistant-output review\n\nYou are a background reviewer. Do not contact the user and do not change workflow state. Review only this redacted assistant-visible text. Explain the uncertainty or risk indicated by the flagged words and quote only the supplied context.\n\n${JSON.stringify(job.input, null, 2)}\n`;
}

export function createHrService({ projectRoot: projectRootInput, repository, kernel, runner = runOpenClawAgent, keywords = DEFAULT_HR_KEYWORDS, clock = () => new Date() } = {}) {
  if (!repository) throw new TypeError('repository is required');
  const projectRoot = resolve(projectRootInput ?? process.cwd());

  async function recordAssistantOutput({ runId = null, taskId = null, agentId, sessionId, sourceEventId = null, text, timestamp = null }) {
    if (agentId === 'hr-agent') return { matches: [], job: null, alert: null };
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
    return repository.queueHrJob({ runId: run.runId, taskId: task.taskId, kind: 'TASK_DAILY_REPORT', sourceAgentId: task.agentId,
      sourceSessionId: task.payload?.session_id ?? null, input: {
        workflow_id: run.workflowId, task_id: task.taskId, task_kind: task.kind, agent_id: task.agentId, task_state: task.state,
        outcome: outcome ?? task.payload?.result?.result_status ?? null, summary_for_user: task.payload?.result?.summary_for_user ?? null,
        summary_for_manager: task.payload?.result?.summary_for_manager ?? null, manager_session_id: run.managerSessionId,
        agent_session_id: task.payload?.session_id ?? null, kernel_events: events,
      } });
  }

  async function runPending({ limit = 20 } = {}) {
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

  return { projectRoot, recordAssistantOutput, queueTaskDailyReport, runPending, keywords };
}
