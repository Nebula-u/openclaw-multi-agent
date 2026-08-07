import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeDurableFile } from '../runtime-core/atomic-store.mjs';

export class LocalAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalAuthorityError';
    this.code = code;
  }
}

export function defaultCapabilityPath(projectRootInput) {
  return resolve(projectRootInput, 'runtime', 'control', '.local-orchestrator.capability');
}

export function initializeLocalAuthority(pathInput) {
  const path = resolve(pathInput);
  if (existsSync(path)) return { path, created: false };
  writeDurableFile(path, `${randomBytes(32).toString('base64url')}\n`, { exclusive: true });
  return { path, created: true };
}

function equalSecret(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeLocalOrchestrator({ capabilityPath, presentedCapability }) {
  const path = resolve(capabilityPath);
  if (!existsSync(path)) throw new LocalAuthorityError('CONTROL_AUTHORITY_NOT_INITIALIZED', `local control capability does not exist: ${path}`);
  const expected = readFileSync(path, 'utf8').trim();
  if (!expected || !presentedCapability || !equalSecret(expected, String(presentedCapability).trim())) {
    throw new LocalAuthorityError('CONTROL_CALLER_UNAUTHORIZED', 'mutation requires the local Orchestrator capability');
  }
  return { actor: 'local-orchestrator', capability_path_abs: path };
}
