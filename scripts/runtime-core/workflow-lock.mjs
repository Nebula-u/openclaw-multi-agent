import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { ensureDirectory, fsyncDirectory } from './atomic-store.mjs';

const DEFAULT_STALE_MS = 2 * 60 * 1000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(path, existing, nowMs, staleMs) {
  if (existing?.hostname === hostname() && Number.isInteger(existing.pid)) {
    return !processIsAlive(existing.pid);
  }
  const acquiredMs = Date.parse(existing?.acquired_at ?? '');
  if (Number.isFinite(acquiredMs)) return nowMs - acquiredMs >= staleMs;
  try {
    return nowMs - lstatSync(path).mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

function preserveStaleLock(path, nowMs) {
  const archivePath = `${path}.stale-${new Date(nowMs).toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}`;
  renameSync(path, archivePath);
  fsyncDirectory(dirname(path));
  return archivePath;
}

export function acquireWorkflowLock(path, {
  purpose = 'workflow-transaction',
  staleMs = DEFAULT_STALE_MS,
  now = () => new Date(),
} = {}) {
  ensureDirectory(dirname(path));
  const acquiredAt = now();
  const owner = {
    schema_version: 1,
    nonce: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    purpose,
    acquired_at: acquiredAt.toISOString(),
    expires_at: new Date(acquiredAt.getTime() + staleMs).toISOString(),
  };
  let recoveredLockPath = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(path, 'wx');
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(dirname(path));
      return {
        owner,
        recovered_lock_path: recoveredLockPath,
        release() {
          if (!existsSync(path)) return;
          const current = readLock(path);
          if (current?.nonce === owner.nonce) {
            unlinkSync(path);
            fsyncDirectory(dirname(path));
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (created && existsSync(path)) {
        try {
          unlinkSync(path);
          fsyncDirectory(dirname(path));
        } catch {
          // Preserve the original write failure. A partial lock is still
          // recoverable by the normal stale-lock path on the next invocation.
        }
      }
      if (error?.code !== 'EEXIST') throw error;
      const nowMs = now().getTime();
      const existing = readLock(path);
      if (attempt === 0 && lockIsStale(path, existing, nowMs, staleMs)) {
        try {
          recoveredLockPath = preserveStaleLock(path, nowMs);
          continue;
        } catch (reclaimError) {
          if (!['ENOENT', 'EACCES', 'EPERM'].includes(reclaimError?.code)) throw reclaimError;
        }
      }
      const conflict = new Error(`lock is already held: ${path}`);
      conflict.code = 'WORKFLOW_LOCK_CONFLICT';
      conflict.lock_owner = existing;
      throw conflict;
    }
  }
  throw new Error(`unable to acquire lock: ${path}`);
}
