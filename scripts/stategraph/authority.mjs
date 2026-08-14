import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function authorityPaths(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  return {
    runtime: join(projectRoot, 'runtime', 'stategraph', 'runtime.capability'),
    human: join(projectRoot, 'runtime', 'stategraph', 'human-approval.capability'),
  };
}

function createSecret(path) {
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { chmodSync(path, 0o600); } catch { /* Windows ACL is documented separately */ }
  return { path, created: true };
}

export function initializeAuthority(projectRoot) {
  const paths = authorityPaths(projectRoot);
  return { runtime: createSecret(paths.runtime), human: createSecret(paths.human) };
}

function matches(expected, supplied) {
  const left = Buffer.from(expected.trim(), 'utf8');
  const right = Buffer.from(String(supplied ?? '').trim(), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function assertAuthority(projectRoot, kind, supplied = null) {
  const path = authorityPaths(projectRoot)[kind];
  if (!path || !existsSync(path)) throw Object.assign(new Error(`${kind} capability is not initialized`), { code: 'STATEGRAPH_CAPABILITY_NOT_INITIALIZED' });
  const envName = kind === 'human' ? 'OPENCLAW_HUMAN_APPROVAL_CAPABILITY' : 'OPENCLAW_STATEGRAPH_CAPABILITY';
  const token = supplied ?? process.env[envName];
  if (!matches(readFileSync(path, 'utf8'), token)) throw Object.assign(new Error(`${kind} capability is invalid`), { code: 'STATEGRAPH_CAPABILITY_INVALID' });
  return true;
}

export function agentEnvironment() {
  const environment = { ...process.env };
  delete environment.OPENCLAW_STATEGRAPH_CAPABILITY;
  delete environment.OPENCLAW_HUMAN_APPROVAL_CAPABILITY;
  delete environment.OPENCLAW_CONTROL_CAPABILITY;
  return environment;
}
