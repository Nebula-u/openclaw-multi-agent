import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ensureDirectory, sha256File, writeDurableFile } from './atomic-store.mjs';
import { acquireWorkflowLock } from './workflow-lock.mjs';

const RECEIPT_ORDER = new Map([
  ['SENT', 1],
  ['ACKNOWLEDGED', 2],
  ['RUNNING', 3],
]);

function ledgerError(code, message, path = '$') {
  const error = new Error(message);
  error.code = code;
  error.path = path;
  return error;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function normalizedPath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertSafeDispatchPath(workflowDir, dispatchId, { requireExisting = true } = {}) {
  if (!/^DSP-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(dispatchId)) {
    throw ledgerError('DISPATCH_ID_INVALID', `invalid dispatch ID: ${dispatchId}`);
  }
  const root = join(workflowDir, 'dispatch');
  const directory = dispatchDirectory(workflowDir, dispatchId);
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) throw ledgerError('DISPATCH_DIR_SYMLINK', 'dispatch root must not be a symbolic link', root);
    const realWorkflow = normalizedPath(realpathSync(workflowDir));
    const realRoot = normalizedPath(realpathSync(root));
    if (realRoot !== realWorkflow && !realRoot.startsWith(`${realWorkflow}${sep}`)) {
      throw ledgerError('DISPATCH_DIR_ESCAPE', 'dispatch root escapes workflow directory', root);
    }
  }
  if (!existsSync(directory)) {
    if (requireExisting) throw ledgerError('DISPATCH_INTENT_NOT_FOUND', `dispatch intent does not exist: ${dispatchId}`, directory);
    return directory;
  }
  if (lstatSync(directory).isSymbolicLink()) throw ledgerError('DISPATCH_DIR_SYMLINK', 'dispatch directory must not be a symbolic link', directory);
  const realRoot = normalizedPath(realpathSync(root));
  const realDirectory = normalizedPath(realpathSync(directory));
  if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${sep}`)) {
    throw ledgerError('DISPATCH_DIR_ESCAPE', 'dispatch directory escapes dispatch root', directory);
  }
  for (const fileName of ['intent.json', 'receipts.jsonl', 'completion-receipt.json', 'dead-letter.json']) {
    const path = join(directory, fileName);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw ledgerError('DISPATCH_RECORD_SYMLINK', 'dispatch records must not be symbolic links', path);
    }
  }
  return directory;
}

function writeImmutableJson(path, value) {
  if (existsSync(path)) {
    const existing = readJson(path);
    if (JSON.stringify(existing) === JSON.stringify(value)) return existing;
    throw ledgerError('DISPATCH_RECORD_IMMUTABLE', `dispatch record already exists with different content: ${path}`, path);
  }
  writeDurableFile(path, `${JSON.stringify(value, null, 2)}\n`, { exclusive: true });
  return value;
}

function appendReceipt(path, receipt) {
  const lock = acquireWorkflowLock(`${path}.lock`, { purpose: 'dispatch-receipt' });
  try {
    const existing = readJsonLines(path);
    const sameStatus = existing.find((record) => record.status === receipt.status);
    if (sameStatus) {
      if (sameStatus.session_key === receipt.session_key && sameStatus.session_id === receipt.session_id) return sameStatus;
      throw ledgerError('DISPATCH_RECEIPT_CONFLICT', `dispatch status ${receipt.status} already has a different session receipt`, path);
    }
    const previous = existing.at(-1);
    if (previous && RECEIPT_ORDER.get(receipt.status) <= RECEIPT_ORDER.get(previous.status)) {
      throw ledgerError('DISPATCH_RECEIPT_ORDER', `${previous.status} cannot transition to ${receipt.status}`, path);
    }
    const descriptor = openSync(path, 'a');
    try {
      appendFileSync(descriptor, `${JSON.stringify(receipt)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return receipt;
  } finally {
    lock.release();
  }
}

export function dispatchDirectory(workflowDir, dispatchId) {
  return join(workflowDir, 'dispatch', dispatchId);
}

export function dispatchIdempotencyKey(intent) {
  return `${intent.workflow_id}/${intent.task_id}/${intent.run_id}/${intent.agent_id}/${intent.attempt}`;
}

export function loadDispatch(workflowDir, dispatchId) {
  const directory = assertSafeDispatchPath(workflowDir, dispatchId);
  const intentPath = join(directory, 'intent.json');
  if (!existsSync(intentPath)) throw ledgerError('DISPATCH_INTENT_NOT_FOUND', `dispatch intent does not exist: ${dispatchId}`, intentPath);
  const completionPath = join(directory, 'completion-receipt.json');
  const deadLetterPath = join(directory, 'dead-letter.json');
  return {
    directory,
    intent: readJson(intentPath),
    receipts: readJsonLines(join(directory, 'receipts.jsonl')),
    completion: existsSync(completionPath) ? readJson(completionPath) : null,
    dead_letter: existsSync(deadLetterPath) ? readJson(deadLetterPath) : null,
  };
}

export function currentDispatchState(record) {
  if (record.dead_letter) return 'DEAD_LETTER';
  if (record.completion) return record.completion.status;
  return record.receipts.at(-1)?.status ?? 'PREPARED';
}

export function dispatchIsTerminal(record) {
  return ['SUCCEEDED', 'FAILED', 'LOST', 'DEAD_LETTER'].includes(currentDispatchState(record));
}

export function scanDispatches(workflowDir) {
  const root = join(workflowDir, 'dispatch');
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw ledgerError('DISPATCH_DIR_SYMLINK', 'dispatch root must not be a symbolic link', root);
  const records = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw ledgerError('DISPATCH_DIR_SYMLINK', 'dispatch directory must not be a symbolic link', join(root, entry.name));
    if (!entry.isDirectory() || !/^DSP-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(entry.name)) {
      throw ledgerError('DISPATCH_LAYOUT_INVALID', 'dispatch root contains a non-dispatch entry', join(root, entry.name));
    }
    records.push(loadDispatch(workflowDir, entry.name));
  }
  return records.sort((left, right) => left.intent.created_at.localeCompare(right.intent.created_at));
}

export function createDispatchIntent({
  workflowDir,
  workflowId,
  task,
  taskFile,
  inputManifestPath,
  sessionKey,
  leaseSeconds,
  retryCount,
  maxRetries,
  dispatchId = `DSP-${randomUUID()}`,
  now = new Date(),
}) {
  const records = scanDispatches(workflowDir);
  const requested = {
    workflow_id: workflowId,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.assigned_agent,
    attempt: task.attempt,
  };
  const idempotencyKey = dispatchIdempotencyKey(requested);
  const inputManifestSha256 = sha256File(inputManifestPath);
  const existingIdempotent = records.find((record) => record.intent.idempotency_key === idempotencyKey);
  if (existingIdempotent) {
    if (existingIdempotent.intent.input_manifest_sha256 !== inputManifestSha256
      || existingIdempotent.intent.session_key !== sessionKey
      || existingIdempotent.intent.retry_count !== retryCount
      || existingIdempotent.intent.max_retries !== maxRetries) {
      throw ledgerError('DISPATCH_IDEMPOTENCY_CONFLICT', 'idempotency key already exists with different dispatch inputs', existingIdempotent.directory);
    }
    return { intent: existingIdempotent.intent, idempotent: true };
  }
  const activeConflict = records.find((record) => record.intent.task_id === task.task_id
    && record.intent.run_id === task.run_id && !dispatchIsTerminal(record));
  if (activeConflict) {
    throw ledgerError('DISPATCH_SCOPE_CONFLICT', `task/run already has an unresolved dispatch: ${activeConflict.intent.dispatch_id}`, activeConflict.directory);
  }
  const intent = {
    schema_version: 1,
    record_type: 'DISPATCH_INTENT',
    dispatch_id: dispatchId,
    idempotency_key: idempotencyKey,
    workflow_id: workflowId,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.assigned_agent,
    attempt: task.attempt,
    task_file_abs: resolve(taskFile),
    input_manifest_path_abs: resolve(inputManifestPath),
    input_manifest_sha256: inputManifestSha256,
    session_key: sessionKey,
    lease_started_at: now.toISOString(),
    lease_deadline: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
    retry_count: retryCount,
    max_retries: maxRetries,
    created_at: now.toISOString(),
    status: 'PREPARED',
  };
  assertSafeDispatchPath(workflowDir, dispatchId, { requireExisting: false });
  ensureDirectory(dispatchDirectory(workflowDir, dispatchId));
  assertSafeDispatchPath(workflowDir, dispatchId);
  writeImmutableJson(join(dispatchDirectory(workflowDir, dispatchId), 'intent.json'), intent);
  return { intent, idempotent: false };
}

function identityFromIntent(intent) {
  return {
    dispatch_id: intent.dispatch_id,
    idempotency_key: intent.idempotency_key,
    workflow_id: intent.workflow_id,
    task_id: intent.task_id,
    run_id: intent.run_id,
    agent_id: intent.agent_id,
    attempt: intent.attempt,
  };
}

export function recordDispatchReceipt({ workflowDir, dispatchId, status, sessionKey, sessionId, now = new Date() }) {
  const directory = dispatchDirectory(workflowDir, dispatchId);
  const lock = acquireWorkflowLock(join(directory, '.dispatch.lock'), { purpose: 'dispatch-transition' });
  try {
    const record = loadDispatch(workflowDir, dispatchId);
    if (dispatchIsTerminal(record)) throw ledgerError('DISPATCH_ALREADY_TERMINAL', `dispatch is already ${currentDispatchState(record)}`, record.directory);
    if (record.intent.session_key !== sessionKey) throw ledgerError('DISPATCH_SESSION_KEY_MISMATCH', 'session key does not match dispatch intent', record.directory);
    const priorSessionIds = new Set(record.receipts.map((receipt) => receipt.session_id));
    if (priorSessionIds.size > 0 && !priorSessionIds.has(sessionId)) throw ledgerError('DISPATCH_SESSION_ID_MISMATCH', 'session ID changed within one dispatch', record.directory);
    const receipt = {
      schema_version: 1,
      record_type: 'DISPATCH_RECEIPT',
      receipt_id: `DRC-${randomUUID()}`,
      ...identityFromIntent(record.intent),
      status,
      session_key: sessionKey,
      session_id: sessionId,
      lease_deadline: record.intent.lease_deadline,
      input_manifest_sha256: record.intent.input_manifest_sha256,
      recorded_at: now.toISOString(),
    };
    return appendReceipt(join(record.directory, 'receipts.jsonl'), receipt);
  } finally {
    lock.release();
  }
}

export function recordCompletionReceipt({
  workflowDir,
  dispatchId,
  status,
  sessionKey,
  sessionId,
  resultPath = null,
  errorCode = null,
  errorMessage = null,
  now = new Date(),
}) {
  const directory = dispatchDirectory(workflowDir, dispatchId);
  const lock = acquireWorkflowLock(join(directory, '.dispatch.lock'), { purpose: 'dispatch-transition' });
  try {
    const record = loadDispatch(workflowDir, dispatchId);
    if (record.dead_letter) throw ledgerError('DISPATCH_ALREADY_TERMINAL', 'dispatch is already dead-lettered', record.directory);
    if (record.completion) {
      const requestedResultPath = resultPath ? resolve(resultPath) : null;
      const requestedResultHash = resultPath && existsSync(resultPath) ? sha256File(resultPath) : null;
      if (record.completion.status === status && record.completion.session_id === sessionId
        && record.completion.session_key === sessionKey
        && record.completion.result_path_abs === requestedResultPath
        && record.completion.result_sha256 === requestedResultHash
        && record.completion.error_code === errorCode
        && record.completion.error_message === errorMessage) {
        return { completion: record.completion, idempotent: true };
      }
      throw ledgerError('DISPATCH_COMPLETION_CONFLICT', 'dispatch already has a different completion receipt', record.directory);
    }
    if (record.receipts.length === 0) throw ledgerError('DISPATCH_RECEIPT_REQUIRED', 'completion requires a prior spawn receipt', record.directory);
    if (record.intent.session_key !== sessionKey || record.receipts.at(-1).session_id !== sessionId) {
      throw ledgerError('DISPATCH_SESSION_ID_MISMATCH', 'completion session does not match dispatch receipts', record.directory);
    }
    if (status === 'SUCCEEDED' && (!resultPath || !existsSync(resultPath))) {
      throw ledgerError('DISPATCH_RESULT_REQUIRED', 'successful completion requires an existing result file', resultPath ?? record.directory);
    }
    const completion = {
      schema_version: 1,
      record_type: 'COMPLETION_RECEIPT',
      completion_id: `CMP-${randomUUID()}`,
      ...identityFromIntent(record.intent),
      status,
      session_key: sessionKey,
      session_id: sessionId,
      result_path_abs: resultPath ? resolve(resultPath) : null,
      result_sha256: resultPath ? sha256File(resultPath) : null,
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: now.toISOString(),
    };
    writeImmutableJson(join(record.directory, 'completion-receipt.json'), completion);
    return { completion, idempotent: false };
  } finally {
    lock.release();
  }
}

export function recordDeadLetter({ workflowDir, dispatchId, reason, lastError = null, now = new Date() }) {
  const directory = dispatchDirectory(workflowDir, dispatchId);
  const lock = acquireWorkflowLock(join(directory, '.dispatch.lock'), { purpose: 'dispatch-transition' });
  try {
    const record = loadDispatch(workflowDir, dispatchId);
    if (record.dead_letter) {
      if (record.dead_letter.reason === reason && record.dead_letter.last_error === lastError) {
        return { dead_letter: record.dead_letter, idempotent: true };
      }
      throw ledgerError('DISPATCH_DEAD_LETTER_CONFLICT', 'dispatch already has a different dead letter', record.directory);
    }
    if (record.intent.retry_count < record.intent.max_retries) {
      throw ledgerError('DISPATCH_RETRIES_REMAIN', `retry_count ${record.intent.retry_count} is below max_retries ${record.intent.max_retries}`, record.directory);
    }
    if (!record.completion || record.completion.status === 'SUCCEEDED') {
      throw ledgerError('DISPATCH_FAILURE_REQUIRED', 'dead-letter requires a FAILED or LOST completion receipt', record.directory);
    }
    const deadLetter = {
      schema_version: 1,
      record_type: 'DEAD_LETTER',
      dead_letter_id: `DLQ-${randomUUID()}`,
      ...identityFromIntent(record.intent),
      status: 'DEAD_LETTER',
      retry_count: record.intent.retry_count,
      max_retries: record.intent.max_retries,
      last_error: lastError,
      reason,
      created_at: now.toISOString(),
    };
    writeImmutableJson(join(record.directory, 'dead-letter.json'), deadLetter);
    return { dead_letter: deadLetter, idempotent: false };
  } finally {
    lock.release();
  }
}

export function reconcileDispatch(record, now = new Date()) {
  const state = currentDispatchState(record);
  const terminal = dispatchIsTerminal(record);
  const leaseExpired = !terminal && now.getTime() > Date.parse(record.intent.lease_deadline);
  return {
    dispatch_id: record.intent.dispatch_id,
    workflow_id: record.intent.workflow_id,
    task_id: record.intent.task_id,
    run_id: record.intent.run_id,
    agent_id: record.intent.agent_id,
    attempt: record.intent.attempt,
    state,
    session_key: record.intent.session_key,
    session_id: record.receipts.at(-1)?.session_id ?? null,
    lease_deadline: record.intent.lease_deadline,
    lease_expired: leaseExpired,
    retry_count: record.intent.retry_count,
    max_retries: record.intent.max_retries,
    action_required: leaseExpired ? 'QUERY_SESSION_BEFORE_RETRY' : null,
  };
}
