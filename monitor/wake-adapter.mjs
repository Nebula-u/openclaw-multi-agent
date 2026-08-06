import { spawn } from 'node:child_process';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';

function defaultRunner(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
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

export function createWakeAdapter({ controlDatabase, supervision, managerSessionKey = null, enabled = false,
  command = 'openclaw', runner = defaultRunner, timeoutSeconds = 60, retryScheduleSeconds = [10, 30, 60, 180],
  now = () => new Date(), publish }) {
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
          if (!managerSessionKey) {
            const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-attempt-${wake.attempts + 1}`, wake_id: wake.wake_id,
              status: 'FAILED', attempted_at: now().toISOString(), manager_session_key: null,
              error: 'MANAGER_SESSION_KEY_REQUIRED', next_attempt_at: retryTime(now(), wake.attempts, retryScheduleSeconds) };
            results.push(supervision.recordWake(record));
            continue;
          }
          const sessionsResult = await runner(command, ['sessions', '--agent', 'manager-agent', '--json', '--limit', 'all'], { timeoutMs: timeoutSeconds * 1000 });
          let sessions = [];
          try { sessions = JSON.parse(sessionsResult.stdout).sessions ?? []; } catch { /* handled below */ }
          if (sessionsResult.exitCode !== 0 || !sessions.some((session) => session.key === managerSessionKey)) {
            const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-attempt-${wake.attempts + 1}`, wake_id: wake.wake_id,
              status: 'FAILED', attempted_at: now().toISOString(), manager_session_key: managerSessionKey,
              error: sessionsResult.exitCode === 0 ? 'MANAGER_SESSION_NOT_FOUND' : 'SESSION_QUERY_FAILED',
              next_attempt_at: retryTime(now(), wake.attempts, retryScheduleSeconds) };
            results.push(supervision.recordWake(record));
            continue;
          }
          const message = `SUPERVISION_REQUEST ${request.request_id}\nRun Control Kernel audit, query the bound workflow/task/dispatch and original session, then claim and process this request. Do not retry or spawn until the original session is confirmed FAILED or LOST.`;
          const sent = await runner(command, ['agent', '--agent', 'manager-agent', '--session-key', managerSessionKey,
            '--message', message, '--json', '--timeout', String(timeoutSeconds)], { timeoutMs: (timeoutSeconds + 5) * 1000 });
          const delivered = sent.exitCode === 0 && !sent.timedOut;
          const record = { schema_version: 1, operation_id: `OP-${wake.wake_id}-attempt-${wake.attempts + 1}`, wake_id: wake.wake_id,
            status: delivered ? 'DELIVERED' : 'FAILED', attempted_at: now().toISOString(), manager_session_key: managerSessionKey,
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

