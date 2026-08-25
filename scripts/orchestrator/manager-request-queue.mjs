import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { assertManagerRequest } from './request-validation.mjs';

const PROCESSED_NOW = Symbol('processedNow');
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function requestRoot(projectRoot, managerWorkspace, runtimeRoot) { return join(resolve(managerWorkspace ?? join(runtimeRoot ?? join(projectRoot, 'runtime'), 'agents', 'manager-agent', 'workspace')), '.orchestrator'); }

export function createManagerRequestProcessor({ orchestrator, projectRoot: projectRootInput, managerWorkspace = null } = {}) {
  if (!orchestrator) throw new TypeError('orchestrator is required');
  const projectRoot = resolve(projectRootInput ?? orchestrator.projectRoot ?? process.cwd());
  const root = requestRoot(projectRoot, managerWorkspace, orchestrator.runtimeRoot ? resolve(orchestrator.runtimeRoot) : null);
  const requests = join(root, 'requests'); const receipts = join(root, 'receipts');
  mkdirSync(requests, { recursive: true }); mkdirSync(receipts, { recursive: true });
  let scanning = false;

  function assertRequest(value) {
    return assertManagerRequest(projectRoot, value);
  }

  async function processFile(name) {
    const path = join(requests, name); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('manager request must be a regular non-symlink file'), { code: 'MANAGER_REQUEST_UNSAFE' });
    const raw = readFileSync(path, 'utf8'); const inputSha256 = sha256(raw); const receiptPath = join(receipts, `${name}.receipt.json`);
    if (existsSync(receiptPath)) {
      const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (existing.input_sha256 === inputSha256) return existing;
    }
    let request;
    try {
      request = assertRequest(JSON.parse(raw));
      let run;
      if (request.request_type === 'CREATE') run = await orchestrator.createRun(request);
      else if (request.request_type === 'CHANGE') run = await orchestrator.reviseRun(request);
      else run = await orchestrator.decide(request);
      const receipt = { schema_version: 1, request_id: request.request_id, request_type: request.request_type, workflow_id: request.workflow_id,
        status: 'ACCEPTED', input_sha256: inputSha256, run_id: run.runId, route_hash: run.routeHash ?? null, processed_at: new Date().toISOString() };
      atomicWriteJson(receiptPath, receipt); Object.defineProperty(receipt, PROCESSED_NOW, { value: true }); return receipt;
    } catch (error) {
      const receipt = { schema_version: 1, request_id: request?.request_id ?? null, request_type: request?.request_type ?? null, workflow_id: request?.workflow_id ?? null,
        status: 'REJECTED', input_sha256: inputSha256, error: { code: error.code ?? 'MANAGER_REQUEST_FAILED', message: error.message, details: error.details ?? null }, processed_at: new Date().toISOString() };
      atomicWriteJson(receiptPath, receipt); return receipt;
    }
  }

  async function scan() {
    if (scanning) return [];
    scanning = true;
    try {
      const results = []; const changed = new Set();
      for (const name of readdirSync(requests).filter((item) => item.endsWith('.json')).sort()) {
        const receipt = await processFile(name); results.push(receipt);
        if (receipt[PROCESSED_NOW] && receipt.status === 'ACCEPTED') changed.add(receipt.workflow_id);
      }
      await orchestrator.tickAll();
      return results;
    } finally { scanning = false; }
  }
  return { root, requests, receipts, processFile, scan };
}
