import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fsyncDirectory, writeDurableFile } from '../runtime-core/atomic-store.mjs';

const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function inside(root, value) {
  const result = relative(resolve(root), resolve(value));
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function entryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function regularFile(path, code, message) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(code, message); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(code, message);
  return stat;
}

function canonicalRootDirectory(path, code, message) {
  let canonical;
  try { canonical = realpathSync.native(path); }
  catch { fail(code, message); }
  let stat;
  try { stat = lstatSync(canonical); }
  catch { fail(code, message); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, message);
  return canonical;
}

function boundedDirectory(path, parent, code) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, 'Manager request directory must already exist as a real directory'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, 'Manager request directory must be a real directory');
  const canonical = realpathSync.native(path);
  if (!inside(parent, canonical)) fail(code, 'Manager request directory escapes its runtime boundary');
  return canonical;
}

function installedProjectRoot(runtimeRoot) {
  const control = boundedDirectory(join(runtimeRoot, 'control'), runtimeRoot, 'MANAGER_INSTALL_MANIFEST_UNSAFE');
  const manifestPath = join(control, 'install-manifest.json');
  regularFile(manifestPath, 'MANAGER_INSTALL_MANIFEST_UNSAFE', 'installed runtime manifest must be a regular single-link file');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { fail('MANAGER_INSTALL_MANIFEST_INVALID', 'installed runtime manifest is not valid JSON'); }
  if (typeof manifest.project_root_abs !== 'string' || !manifest.project_root_abs) {
    fail('MANAGER_PROJECT_ROOT_MISSING', 'installed project root is unavailable');
  }
  return manifest.project_root_abs;
}

function parseValidatorOutput(result) {
  let output;
  try { output = JSON.parse(String(result.stdout ?? '').trim()); }
  catch { fail('MANAGER_REQUEST_VALIDATOR_FAILED', 'authoritative request validator returned invalid JSON', { status: result.status ?? null }); }
  if (result.error || result.status !== 0 || output?.ok !== true) {
    const error = output?.error ?? {};
    fail(error.code ?? 'MANAGER_REQUEST_VALIDATOR_FAILED', error.message ?? 'authoritative request validation failed', error.details ?? {});
  }
  return output;
}

export function createManagerRequestSubmission({ projectRoot: projectRootInput = null, runtimeRoot: runtimeRootInput, runValidator = null } = {}) {
  if (!runtimeRootInput) throw new TypeError('runtimeRoot is required');
  const runtimeRoot = canonicalRootDirectory(resolve(runtimeRootInput), 'MANAGER_RUNTIME_ROOT_UNSAFE', 'installed runtime root is unavailable or unsafe');
  const projectRoot = canonicalRootDirectory(
    resolve(projectRootInput ?? installedProjectRoot(runtimeRoot)),
    'MANAGER_PROJECT_ROOT_UNSAFE',
    'installed project root is unavailable or unsafe',
  );
  const agentsRoot = boundedDirectory(join(runtimeRoot, 'agents'), runtimeRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const managerRoot = boundedDirectory(join(agentsRoot, 'manager-agent'), agentsRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const managerWorkspace = boundedDirectory(join(managerRoot, 'workspace'), managerRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const requestRoot = boundedDirectory(join(managerWorkspace, '.orchestrator'), managerWorkspace, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const drafts = boundedDirectory(join(requestRoot, 'drafts'), requestRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const requests = boundedDirectory(join(requestRoot, 'requests'), requestRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const receipts = boundedDirectory(join(requestRoot, 'receipts'), requestRoot, 'MANAGER_REQUEST_DIRECTORY_UNSAFE');
  const scriptsRoot = boundedDirectory(join(projectRoot, 'scripts'), projectRoot, 'MANAGER_REQUEST_VALIDATOR_UNSAFE');
  const cliPath = join(scriptsRoot, 'orchestrator-cli.mjs');
  regularFile(cliPath, 'MANAGER_REQUEST_VALIDATOR_UNSAFE', 'authoritative request validator entrypoint is unavailable or unsafe');
  const canonicalCliPath = realpathSync.native(cliPath);
  if (!inside(projectRoot, canonicalCliPath)) fail('MANAGER_REQUEST_VALIDATOR_UNSAFE', 'authoritative request validator escapes the project root');
  const invokeValidator = runValidator ?? ((draftBytes) => spawnSync(process.execPath, [
    canonicalCliPath, 'validate-request', '--project-root', projectRoot, '--request-stdin', 'true',
  ], { shell: false, windowsHide: true, encoding: 'utf8', input: draftBytes, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }));

  function draftPath(draftFile) {
    if (typeof draftFile !== 'string' || !DRAFT_NAME.test(draftFile) || draftFile.includes('/') || draftFile.includes('\\') || isAbsolute(draftFile)) {
      fail('MANAGER_REQUEST_DRAFT_NAME_INVALID', 'draft file must be a JSON basename');
    }
    const path = join(drafts, draftFile);
    if (!inside(drafts, path)) fail('MANAGER_REQUEST_DRAFT_NAME_INVALID', 'draft file escapes the draft directory');
    return path;
  }

  function readDraft(draftFile) {
    const path = draftPath(draftFile);
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1) fail('MANAGER_REQUEST_DRAFT_UNSAFE', 'draft must be a regular single-link file');
      const value = readFileSync(descriptor);
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) {
        fail('MANAGER_REQUEST_DRAFT_UNSAFE', 'draft changed while it was being read');
      }
      return { path, value, inputSha256: sha256(value) };
    } catch (error) {
      if (error?.code?.startsWith?.('MANAGER_REQUEST_')) throw error;
      fail(entryExists(path) ? 'MANAGER_REQUEST_DRAFT_UNSAFE' : 'MANAGER_REQUEST_DRAFT_NOT_FOUND', 'draft is unavailable or unsafe');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function validateReadDraft(draftFile) {
    const draft = readDraft(draftFile);
    const validated = parseValidatorOutput(invokeValidator(draft.value));
    if (!['CREATE', 'CHANGE'].includes(validated.request_type)) {
      fail('MANAGER_REQUEST_DRAFT_TYPE_INVALID', 'draft submission only accepts CREATE or CHANGE requests');
    }
    return { draft, validated };
  }

  function validateDraft(draftFile) {
    const { draft, validated } = validateReadDraft(draftFile);
    return {
      status: 'VALID', request_id: validated.request_id, request_type: validated.request_type,
      workflow_id: validated.workflow_id, input_sha256: draft.inputSha256,
    };
  }

  function submitDraft(draftFile, expectedSha256) {
    if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) fail('MANAGER_REQUEST_EXPECTED_SHA256_INVALID', 'expected SHA-256 must be 64 lowercase hex characters');
    const draft = readDraft(draftFile);
    if (draft.inputSha256 !== expectedSha256) fail('MANAGER_REQUEST_DRAFT_HASH_MISMATCH', 'draft changed after validation', { expected_sha256: expectedSha256, actual_sha256: draft.inputSha256 });
    const validated = parseValidatorOutput(invokeValidator(draft.value));
    if (!['CREATE', 'CHANGE'].includes(validated.request_type)) {
      fail('MANAGER_REQUEST_DRAFT_TYPE_INVALID', 'draft submission only accepts CREATE or CHANGE requests');
    }
    const target = join(requests, draftFile);
    const receipt = join(receipts, `${draftFile}.receipt.json`);
    if (entryExists(target) || entryExists(receipt)) fail('MANAGER_REQUEST_TARGET_EXISTS', 'formal request or receipt already exists');
    const temporary = join(requests, `.${draftFile}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeDurableFile(temporary, draft.value, { exclusive: true });
      try { linkSync(temporary, target); }
      catch (error) {
        if (error?.code === 'EEXIST') fail('MANAGER_REQUEST_TARGET_EXISTS', 'formal request or receipt already exists');
        throw error;
      }
      fsyncDirectory(requests);
    } finally {
      if (entryExists(temporary)) unlinkSync(temporary);
      fsyncDirectory(requests);
    }
    return {
      status: 'QUEUED', request_id: validated.request_id, request_type: validated.request_type,
      workflow_id: validated.workflow_id, input_sha256: draft.inputSha256, request_path: target,
    };
  }

  return { validateDraft, submitDraft, drafts, requests, receipts };
}
