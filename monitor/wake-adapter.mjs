import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { createManagerSessionContext } from '../scripts/orchestrator/manager-context.mjs';
import { terminateProcessTree } from '../scripts/orchestrator/agent-process.mjs';

function defaultRunner(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const terminated = terminateProcessTree(child.pid);
      if (!terminated.ok) child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { if (Buffer.concat(stdout).length < 1024 * 1024) stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { if (Buffer.concat(stderr).length < 1024 * 1024) stderr.push(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: null, stdout: '', stderr: error.message, timedOut }); });
    child.on('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut }); });
  });
}

function retryTime(now, attempts, scheduleSeconds) {
  const seconds = scheduleSeconds[Math.min(attempts, scheduleSeconds.length - 1)] ?? 180;
  return new Date(now.valueOf() + seconds * 1000).toISOString();
}

export function createWakeAdapter({ projectRoot = process.cwd(), controlDatabase, supervision, managerSessionKey = null, enabled = false,
  command = 'openclaw', runner = defaultRunner, timeoutSeconds = 60, retryScheduleSeconds = [10, 30, 60, 180],
  now = () => new Date(), publish }) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) {
    throw new Error('manager wake timeout must be an integer between 1 and 300 seconds');
  }
  let running = false;
  return {
    async scan() {
      if (!enabled || running) return [];
      running = true;
      const results = [];
      try {
        const audit = auditControlDatabase(controlDatabase);
        if (!audit.ok) return [{ ok: false, code: 'CONTROL_AUDIT_FAILED', audit }];
        const pending = supervision.wakeOutbox().filter((wake) => !wake.next_attempt_at || Date.parse(wake.next_attempt_at) <= now().valueOf());
        for (const wake of pending) {
          const request = supervision.get(wake.request_id);
          if (!request) continue;
          if (request.status !== 'REQUESTED') {
            const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-settled`, wake_id: wake.wake_id,
              status: 'DELIVERED', attempted_at: now().toISOString(), manager_session_key: request.claimed_by ?? managerSessionKey,
              error: null, next_attempt_at: null };
            results.push(supervision.recordWake(record));
            continue;
          }
          const sessionsResult = await runner(command, ['sessions', '--agent', 'manager-agent', '--json', '--limit', 'all'], { timeoutMs: timeoutSeconds * 1000 });
          let sessions = [];
          try { sessions = JSON.parse(sessionsResult.stdout).sessions ?? []; } catch { /* handled below */ }
          const managerSession = managerSessionKey
            ? sessions.find((session) => session.key === managerSessionKey)
            : sessions.toSorted((left, right) => Date.parse(right.updated_at ?? right.updatedAt ?? 0) - Date.parse(left.updated_at ?? left.updatedAt ?? 0))[0];
          const selectedSessionKey = managerSession?.key ?? managerSessionKey;
          if (sessionsResult.exitCode !== 0 || !managerSession) {
            const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-attempt-${wake.attempts + 1}`, wake_id: wake.wake_id,
              status: 'FAILED', attempted_at: now().toISOString(), manager_session_key: selectedSessionKey ?? null,
              error: sessionsResult.exitCode === 0 ? 'MANAGER_SESSION_NOT_FOUND' : 'SESSION_QUERY_FAILED',
              next_attempt_at: retryTime(now(), wake.attempts, retryScheduleSeconds) };
            results.push(supervision.recordWake(record));
            continue;
          }
          const context = createManagerSessionContext({ projectRoot, database: controlDatabase,
            workflowId: request.workflow_id,
            estimatedTokens: managerSession.totalTokens ?? managerSession.total_tokens ?? null });
          const message = `SUPERVISION_REQUEST ${request.request_id}\nUse only the attached manager_context as control-plane context. Run the local Orchestrator audit and process this request through supported operations. Do not query or write SQLite directly and do not spawn worker sessions.\nmanager_context=${JSON.stringify(context)}`;
          const rolloverSessionId = context.session_policy.action === 'START_NEW_MANAGER_SESSION' ? randomUUID() : null;
          const sessionArgs = rolloverSessionId ? ['--session-id', rolloverSessionId] : ['--session-key', selectedSessionKey];
          const deliveredSessionKey = rolloverSessionId ? `agent:manager-agent:orchestrator:${rolloverSessionId}` : selectedSessionKey;
          const sent = await runner(command, ['agent', '--agent', 'manager-agent', ...sessionArgs,
            '--message', message, '--json', '--timeout', String(timeoutSeconds)], { timeoutMs: timeoutSeconds * 1000 });
          const delivered = sent.exitCode === 0 && !sent.timedOut;
          const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-attempt-${wake.attempts + 1}`, wake_id: wake.wake_id,
            status: delivered ? 'DELIVERED' : 'FAILED', attempted_at: now().toISOString(), manager_session_key: deliveredSessionKey,
            error: delivered ? null : sent.timedOut ? 'MANAGER_WAKE_TIMEOUT' : 'MANAGER_WAKE_FAILED',
            next_attempt_at: delivered ? null : retryTime(now(), wake.attempts, retryScheduleSeconds) };
          const result = supervision.recordWake(record);
          results.push(result);
          publish?.('supervision', result, { source: 'MANAGER_WAKE_ADAPTER' });
        }
        return results;
      } finally { running = false; }
    },
  };
}

