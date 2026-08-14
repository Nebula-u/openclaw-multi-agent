import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function withWorkflowLock(projectRootInput, workflowId, operation, { staleMs = 20 * 60 * 1000 } = {}) {
  const directory = join(resolve(projectRootInput), 'runtime', 'stategraph', 'locks');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${workflowId}.lock`);
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= staleMs) {
      const owner = (() => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } })();
      throw Object.assign(new Error(`workflow is already running: ${workflowId}`), { code: 'STATEGRAPH_WORKFLOW_LOCKED', details: { owner } });
    }
    unlinkSync(path);
    descriptor = openSync(path, 'wx', 0o600);
  }
  writeFileSync(descriptor, JSON.stringify({ workflow_id: workflowId, pid: process.pid, acquired_at: new Date().toISOString() }));
  closeSync(descriptor);
  try {
    return await operation();
  } finally {
    try { unlinkSync(path); } catch { /* exact lock already removed */ }
  }
}
