import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireWorkflowLock } from '../runtime-core/workflow-lock.mjs';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { createManagerRequestProcessor } from './manager-request-queue.mjs';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_STOP_TIMEOUT_MS = 120_000;

function serviceRoot(projectRoot) { return join(projectRoot, 'runtime', 'orchestrator', 'service'); }
function pathsFor(projectRoot) {
  const root = serviceRoot(projectRoot);
  return {
    root,
    lock: join(root, 'foreground.lock'),
    status: join(root, 'foreground.status.json'),
    stop: join(root, 'foreground.stop.json'),
  };
}

export function acquireOrchestratorWriterLock(projectRootInput, { purpose = 'orchestrator-writer', staleMs } = {}) {
  const projectRoot = resolve(projectRootInput);
  const paths = pathsFor(projectRoot); mkdirSync(paths.root, { recursive: true });
  return acquireWorkflowLock(paths.lock, { purpose, ...(staleMs === undefined ? {} : { staleMs }) });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function removeIfPresent(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* a stale control file is harmless */ }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function reconcileServiceStatus(status, {
  clock = () => new Date(),
  isProcessAlive = processIsAlive,
  staleAfterMs = null,
} = {}) {
  if (!status || !['STARTING', 'RUNNING', 'DRAINING'].includes(status.state)) return status;
  const recordedState = status.state;
  let staleReason = null;
  if (!isProcessAlive(Number(status.pid))) staleReason = 'PROCESS_NOT_FOUND';
  const heartbeatMs = Date.parse(status.heartbeat_at);
  const derivedStaleAfterMs = Number.isFinite(staleAfterMs) && staleAfterMs > 0
    ? staleAfterMs
    : Math.max(5000, Number(status.poll_ms) * 3 || 0);
  if (!staleReason && (!Number.isFinite(heartbeatMs) || clock().getTime() - heartbeatMs > derivedStaleAfterMs)) {
    staleReason = 'HEARTBEAT_EXPIRED';
  }
  return staleReason ? { ...status, state: 'STALE', recorded_state: recordedState, stale_reason: staleReason } : status;
}

function wait(milliseconds, signal) {
  return new Promise((resolveWait) => {
    if (signal?.aborted) return resolveWait();
    const timer = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
  });
}

export function readForegroundServiceStatus(projectRootInput, options = {}) {
  const projectRoot = resolve(projectRootInput);
  return reconcileServiceStatus(readJson(pathsFor(projectRoot).status), options);
}

export function requestForegroundServiceStop(projectRootInput, options = {}) {
  const projectRoot = resolve(projectRootInput);
  const paths = pathsFor(projectRoot);
  const status = reconcileServiceStatus(readJson(paths.status), options);
  const staleButAlive = status?.state === 'STALE' && status.stale_reason === 'HEARTBEAT_EXPIRED';
  if (!status || (!['STARTING', 'RUNNING', 'DRAINING'].includes(status.state) && !staleButAlive)) {
    throw Object.assign(new Error('the foreground Orchestrator service is not running'), { code: 'ORCHESTRATOR_NOT_RUNNING' });
  }
  atomicWriteJson(paths.stop, { schema_version: 1, requested_at: new Date().toISOString(), instance_id: status.instance_id, requested_by: 'local-cli' });
  return { requested: true, instance_id: status.instance_id, status_path: paths.status };
}

/**
 * Runs the only supported foreground scheduler loop.  It deliberately owns no
 * workflow facts: the SQLite kernel remains authoritative, while this file
 * supplies process lifetime, single-instance exclusion, and observable health.
 */
export async function runForegroundService({
  projectRoot: projectRootInput,
  orchestrator,
  hr,
  managerWorkspace = null,
  pollMs = DEFAULT_POLL_MS,
  shutdownTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  signal = null,
  abort = null,
  clock = () => new Date(),
  waitFor = wait,
  writerLock = null,
} = {}) {
  if (!orchestrator || !hr) throw new TypeError('orchestrator and hr are required');
  const projectRoot = resolve(projectRootInput ?? orchestrator.projectRoot ?? process.cwd());
  if (!Number.isInteger(pollMs) || pollMs < 100) throw new RangeError('pollMs must be an integer of at least 100 ms');
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1000) throw new RangeError('shutdownTimeoutMs must be an integer of at least 1000 ms');
  const paths = pathsFor(projectRoot); mkdirSync(paths.root, { recursive: true });
  const lock = writerLock ?? acquireOrchestratorWriterLock(projectRoot, {
    purpose: 'foreground-orchestrator-service', staleMs: Math.max(shutdownTimeoutMs * 2, 300_000),
  });
  const instanceId = lock.owner.nonce;
  const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace });
  let state = 'STARTING'; let lastError = null; let cycles = 0; let stopRequestedAt = null;
  let draining = false; let forcedShutdown = false; let drainTimer = null; let hrRunning = false;
  const startedAt = clock().toISOString();

  const publish = () => atomicWriteJson(paths.status, {
    schema_version: 1, service: 'foreground-orchestrator', instance_id: instanceId, pid: process.pid,
    state, started_at: startedAt, heartbeat_at: clock().toISOString(), stop_requested_at: stopRequestedAt,
    cycles, last_error: lastError, poll_ms: pollMs,
  });
  const beginDrain = () => {
    if (draining) return;
    draining = true; state = 'DRAINING'; stopRequestedAt = clock().toISOString(); publish();
    drainTimer = setTimeout(() => {
      forcedShutdown = true;
      abort?.();
    }, shutdownTimeoutMs);
    drainTimer.unref?.();
  };
  const shouldDrain = () => {
    if (signal?.aborted) { beginDrain(); return true; }
    if (existsSync(paths.stop)) { beginDrain(); return true; }
    return draining;
  };
  const runHrInBackground = () => {
    if (hr.autoMode === 'off' || hrRunning || draining) return;
    hrRunning = true;
    void hr.runPending().catch((error) => {
      lastError = { code: error.code ?? 'HR_SERVICE_CYCLE_FAILED', message: error.message, at: clock().toISOString() };
      publish();
    }).finally(() => { hrRunning = false; });
  };
  const stopWatcher = setInterval(() => { if (existsSync(paths.stop)) beginDrain(); }, Math.min(pollMs, 250));
  stopWatcher.unref?.();

  try {
    removeIfPresent(paths.stop); // A stop request belongs only to an already-running instance.
    publish();
    state = 'RUNNING'; publish();
    while (!shouldDrain()) {
      try {
        const requests = await processor.scan();
        runHrInBackground();
        cycles += 1; lastError = null;
        publish();
        // Keep the latest cycle facts in the status file without duplicating
        // durable workflow facts outside the Kernel.
        void requests;
      } catch (error) {
        cycles += 1;
        lastError = { code: error.code ?? 'ORCHESTRATOR_SERVICE_CYCLE_FAILED', message: error.message, at: clock().toISOString() };
        publish();
      }
      await waitFor(pollMs, signal);
    }
    beginDrain();
    state = 'STOPPED'; publish();
    return { ok: true, state, instance_id: instanceId, cycles, forced_shutdown: forcedShutdown, status_path: paths.status };
  } finally {
    clearInterval(stopWatcher);
    if (drainTimer) clearTimeout(drainTimer);
    removeIfPresent(paths.stop);
    lock.release();
  }
}
