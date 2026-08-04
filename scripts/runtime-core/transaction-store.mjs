import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  atomicWriteJson,
  ensureDirectory,
  replaceFileAtomic,
  sha256File,
  sha256Text,
  writeDurableFile,
} from './atomic-store.mjs';

function injectedCrash(point) {
  if (process.env.RUNTIME_GUARD_TEST_CRASH_AFTER === point) process.exit(86);
}

function normalizedPath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathEquals(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathWithin(root, candidate) {
  const normalizedRoot = normalizedPath(root);
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function unsafeJournal(message) {
  const error = new Error(message);
  error.code = 'TRANSACTION_JOURNAL_UNSAFE';
  throw error;
}

function assertJournalSafe(journal, transactionDir, workflowDir) {
  if (!journal || journal.schema_version !== 1 || journal.transaction_id !== basename(transactionDir)
    || journal.workflow_id !== basename(workflowDir)) {
    unsafeJournal(`transaction journal scope is invalid: ${transactionDir}`);
  }
  if (!Number.isInteger(journal.expected_revision) || journal.expected_revision < 0
    || journal.target_revision !== journal.expected_revision + 1
    || !['PREPARED', 'APPLYING', 'COMMITTED'].includes(journal.status)
    || !Array.isArray(journal.operations) || journal.operations.length < 3) {
    unsafeJournal(`transaction journal shape is invalid: ${transactionDir}`);
  }
  const runtimeRoot = resolve(workflowDir, '..', '..', '..');
  const exactTargets = new Map([
    ['event-chain', join(workflowDir, 'events.jsonl')],
    ['workflow', join(workflowDir, 'workflow.json')],
    ['active-index', join(runtimeRoot, 'control', 'active-workflows.json')],
  ]);
  const requiredKinds = new Set(exactTargets.keys());
  const seenKinds = new Set();
  const seenTargets = new Set();
  for (const operation of journal.operations) {
    if (!operation || typeof operation.kind !== 'string' || typeof operation.target_path_abs !== 'string'
      || typeof operation.staged_path_abs !== 'string' || !/^[a-f0-9]{64}$/u.test(operation.content_sha256 ?? '')) {
      unsafeJournal(`transaction operation shape is invalid: ${transactionDir}`);
    }
    const normalizedTarget = normalizedPath(operation.target_path_abs);
    if (seenTargets.has(normalizedTarget)) unsafeJournal(`transaction target is repeated: ${operation.target_path_abs}`);
    seenTargets.add(normalizedTarget);
    seenKinds.add(operation.kind);
    if (!pathWithin(join(transactionDir, 'staged'), operation.staged_path_abs)) {
      unsafeJournal(`transaction staged path escapes its journal: ${operation.staged_path_abs}`);
    }
    if (exactTargets.has(operation.kind)) {
      if (!pathEquals(operation.target_path_abs, exactTargets.get(operation.kind))) {
        unsafeJournal(`transaction ${operation.kind} target is not canonical: ${operation.target_path_abs}`);
      }
    } else if (operation.kind === 'task-current') {
      if (!pathWithin(join(workflowDir, 'tasks'), operation.target_path_abs)
        || !pathEquals(dirname(operation.target_path_abs), join(workflowDir, 'tasks'))
        || !operation.target_path_abs.endsWith('.json')) {
        unsafeJournal(`transaction task-current target is not canonical: ${operation.target_path_abs}`);
      }
    } else if (operation.kind === 'task-run-history') {
      if (!pathWithin(join(workflowDir, 'task-runs'), operation.target_path_abs)
        || !operation.target_path_abs.endsWith('.json')) {
        unsafeJournal(`transaction task-run-history target is not canonical: ${operation.target_path_abs}`);
      }
    } else {
      unsafeJournal(`transaction operation kind is not allowed: ${operation.kind}`);
    }
  }
  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) unsafeJournal(`transaction is missing required operation: ${kind}`);
  }
}

function operationRecord(transactionDir, operation, index) {
  const content = Buffer.isBuffer(operation.content)
    ? operation.content
    : Buffer.from(String(operation.content), 'utf8');
  const stagedPath = join(transactionDir, 'staged', `${String(index + 1).padStart(2, '0')}-${operation.kind}-${basename(operation.targetPath)}.tmp`);
  writeDurableFile(stagedPath, content, { exclusive: true });
  return {
    kind: operation.kind,
    target_path_abs: resolve(operation.targetPath),
    staged_path_abs: resolve(stagedPath),
    content_sha256: sha256Text(content.toString('utf8')),
    applied: false,
    applied_at: null,
  };
}

function writeJournal(path, journal) {
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(path, journal);
}

function applyOperation(operation) {
  if (existsSync(operation.target_path_abs)
    && sha256File(operation.target_path_abs) === operation.content_sha256) {
    if (existsSync(operation.staged_path_abs)) unlinkSync(operation.staged_path_abs);
    return;
  }
  if (!existsSync(operation.staged_path_abs)
    || sha256File(operation.staged_path_abs) !== operation.content_sha256) {
    const error = new Error(`transaction content is unavailable or changed: ${operation.target_path_abs}`);
    error.code = 'TRANSACTION_RECOVERY_HASH_MISMATCH';
    error.operation = operation;
    throw error;
  }
  replaceFileAtomic(operation.staged_path_abs, operation.target_path_abs);
}

function applyJournal(journalPath, journal, { allowCrash = false } = {}) {
  if (journal.status === 'PREPARED') {
    journal.status = 'APPLYING';
    writeJournal(journalPath, journal);
    if (allowCrash) injectedCrash('after-applying');
  }
  for (const operation of journal.operations) {
    if (!operation.applied) {
      applyOperation(operation);
      if (allowCrash) injectedCrash(`after-operation:${operation.kind}`);
      operation.applied = true;
      operation.applied_at = new Date().toISOString();
      writeJournal(journalPath, journal);
    } else if (!existsSync(operation.target_path_abs)
      || sha256File(operation.target_path_abs) !== operation.content_sha256) {
      // An applied operation may have been superseded by a later committed
      // transaction. During recovery, only incomplete journals reach here, so
      // a mismatch means the unfinished transaction cannot be proven safe.
      const error = new Error(`applied transaction target changed before commit: ${operation.target_path_abs}`);
      error.code = 'TRANSACTION_RECOVERY_HASH_MISMATCH';
      error.operation = operation;
      throw error;
    }
  }
  journal.status = 'COMMITTED';
  journal.committed_at = new Date().toISOString();
  writeJournal(journalPath, journal);
  if (allowCrash) injectedCrash('after-committed');
  return journal;
}

export function commitTransaction({
  workflowDir,
  workflowId,
  expectedRevision,
  targetRevision,
  ownerNonce,
  operations,
}) {
  const transactionId = `TXN-${randomUUID()}`;
  const transactionDir = join(workflowDir, 'transactions', transactionId);
  ensureDirectory(join(transactionDir, 'staged'));
  const timestamp = new Date().toISOString();
  const journal = {
    schema_version: 1,
    transaction_id: transactionId,
    workflow_id: workflowId,
    owner_nonce: ownerNonce,
    expected_revision: expectedRevision,
    target_revision: targetRevision,
    status: 'PREPARED',
    created_at: timestamp,
    updated_at: timestamp,
    committed_at: null,
    operations: operations.map((operation, index) => operationRecord(transactionDir, operation, index)),
  };
  const journalPath = join(transactionDir, 'transaction.json');
  assertJournalSafe(journal, transactionDir, workflowDir);
  atomicWriteJson(journalPath, journal);
  injectedCrash('after-prepared');
  return applyJournal(journalPath, journal, { allowCrash: true });
}

export function recoverTransactions(workflowDir) {
  const transactionsRoot = join(workflowDir, 'transactions');
  if (!existsSync(transactionsRoot)) return [];
  const recovered = [];
  const pending = [];
  for (const entry of readdirSync(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('TXN-')) continue;
    const transactionDir = join(transactionsRoot, entry.name);
    const journalPath = join(transactionDir, 'transaction.json');
    if (!existsSync(journalPath)) continue;
    if (lstatSync(journalPath).isSymbolicLink()) unsafeJournal(`transaction journal must not be a symbolic link: ${journalPath}`);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (!['PREPARED', 'APPLYING'].includes(journal.status)) continue;
    assertJournalSafe(journal, transactionDir, workflowDir);
    pending.push({ journalPath, journal });
  }
  pending.sort((left, right) => left.journal.expected_revision - right.journal.expected_revision
    || Date.parse(left.journal.created_at) - Date.parse(right.journal.created_at));
  for (const { journalPath, journal } of pending) {
    applyJournal(journalPath, journal);
    recovered.push(journal.transaction_id);
  }
  return recovered;
}
