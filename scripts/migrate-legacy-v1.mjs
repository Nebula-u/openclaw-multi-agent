#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson, writeDurableFile } from './runtime-core/atomic-store.mjs';
import { createControlRepository, openControlDatabase } from './control-core/repository.mjs';
import { exportControlProjections } from './control-core/projections.mjs';

const ZERO_HASH = '0'.repeat(64);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function safeId(value, prefix) {
  if (!new RegExp(`^${prefix}-[A-Za-z0-9][A-Za-z0-9-]*$`, 'u').test(value)) throw new Error(`invalid ${prefix} id: ${value}`);
  return value;
}

function filesBelow(root) {
  if (!existsSync(root)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`forensic source contains a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`forensic source contains an unsupported entry: ${path}`);
    }
  }
  visit(root);
  return files.sort((left, right) => relative(root, left).replaceAll('\\', '/').localeCompare(relative(root, right).replaceAll('\\', '/'), 'en'));
}

export function inventoryTree(rootInput) {
  const root = resolve(rootInput);
  const files = filesBelow(root).map((path) => ({
    path_rel: relative(root, path).replaceAll('\\', '/'),
    bytes: readFileSync(path).length,
    sha256: sha256(readFileSync(path)),
  }));
  return { root_abs: root, files, bytes: files.reduce((sum, item) => sum + item.bytes, 0), tree_sha256: sha256(canonicalJson(files)) };
}

function eventHash(event) {
  const { event_hash: ignored, ...unsigned } = event;
  return sha256(canonicalJson(unsigned));
}

function inspectEvents(path) {
  const errors = [];
  const records = [];
  if (!existsSync(path)) return { records: 0, trusted_prefix_revision: 0, fully_trusted: false, errors: [{ code: 'LEGACY_EVENTS_MISSING', path }] };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim());
  let trusted = 0;
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try { event = JSON.parse(lines[index]); }
    catch (error) { errors.push({ code: 'LEGACY_EVENT_JSON_INVALID', line: index + 1, message: error.message }); break; }
    records.push(event);
    const expected = index + 1;
    const issues = [];
    if (event.seq !== expected || event.state_revision !== expected) issues.push('LEGACY_EVENT_REVISION_MISMATCH');
    if (event.previous_event_hash !== previousHash) issues.push('LEGACY_EVENT_PREVIOUS_HASH_MISMATCH');
    if (typeof event.event_hash !== 'string' || event.event_hash !== eventHash(event)) issues.push('LEGACY_EVENT_HASH_MISMATCH');
    if (issues.length) {
      errors.push(...issues.map((code) => ({ code, line: index + 1 })));
      break;
    }
    trusted = expected;
    previousHash = event.event_hash;
  }
  if (trusted < lines.length && errors.length === 0) errors.push({ code: 'LEGACY_EVENT_CHAIN_UNTRUSTED_SUFFIX', line: trusted + 1 });
  return { records: lines.length, trusted_prefix_revision: trusted, fully_trusted: trusted === lines.length, errors };
}

function inspectSnapshot(workflowRoot) {
  const path = join(workflowRoot, 'workflow.json');
  try {
    const value = jsonFile(path);
    return {
      parseable: true,
      claimed_revision: Number.isInteger(value.state_revision) ? value.state_revision : (Number.isInteger(value.revision) ? value.revision : null),
      status: typeof value.status === 'string' ? value.status : null,
      phase: typeof value.current_phase === 'string' ? value.current_phase : (typeof value.phase === 'string' ? value.phase : null),
      candidate_commit: typeof value.current_candidate_commit === 'string' ? value.current_candidate_commit : null,
    };
  } catch {
    return { parseable: false, claimed_revision: null, status: null, phase: null, candidate_commit: null };
  }
}

function attachCrossChecks(snapshot, events, activeEntry) {
  const terminal = new Set(['QUARANTINED', 'READY_FOR_OPERATIONS_HANDOFF', 'RELEASE_NO_GO', 'RELEASE_HOLD', 'FAILED', 'CANCELLED']);
  const activeMatches = activeEntry
    ? activeEntry.state_revision === snapshot.claimed_revision
      && activeEntry.status === snapshot.status
      && activeEntry.current_phase === snapshot.phase
      && (activeEntry.current_candidate_commit ?? null) === snapshot.candidate_commit
    : terminal.has(snapshot.status);
  return {
    snapshot: { ...snapshot, active_index_entry: activeEntry ?? null, active_index_matches_snapshot: activeMatches },
    events: { ...events, snapshot_revision_matches: snapshot.claimed_revision === events.trusted_prefix_revision },
  };
}

function archiveCopy(source, destination, expected) {
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  }
  const actual = inventoryTree(destination);
  if (actual.tree_sha256 !== expected.tree_sha256) throw new Error(`archive verification failed: ${destination}`);
  return actual;
}

function makeReadOnly(root) {
  if (!existsSync(root)) return;
  for (const path of filesBelow(root)) chmodSync(path, 0o444);
  const directories = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) visit(join(directory, entry.name));
    directories.push(directory);
  }
  visit(root);
  for (const directory of directories) chmodSync(directory, 0o555);
}

function initializeQuarantines(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_quarantines (
      workflow_id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL,
      control_tree_sha256 TEXT NOT NULL,
      artifact_tree_sha256 TEXT,
      archive_root_abs TEXT NOT NULL,
      report_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS legacy_quarantines_no_update
      BEFORE UPDATE ON legacy_quarantines BEGIN SELECT RAISE(ABORT, 'legacy quarantine reports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_quarantines_no_delete
      BEFORE DELETE ON legacy_quarantines BEGIN SELECT RAISE(ABORT, 'legacy quarantine reports are immutable'); END;
  `);
}

function importTombstone(repository, database, report) {
  const contractSet = 'legacy-quarantine-tombstone-v1';
  let state = repository.get(report.workflow_id);
  if (!state) {
    repository.apply({
      schema_version: 1, command_id: `CMD-${report.migration_id}-${report.workflow_id}-BOOTSTRAP`, workflow_id: report.workflow_id,
      expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'legacy-migration', occurred_at: report.created_at,
      reason: 'Create a v2 tombstone for an untrusted legacy workflow; this is not a history import.',
      payload: { contract_set_id: contractSet, agent_bundle_id: report.control_tree_sha256 },
    });
    state = repository.get(report.workflow_id);
  }
  if (state.contract_set_id !== contractSet || state.current_candidate_commit !== null) {
    throw new Error(`existing v2 workflow is not a legacy tombstone: ${report.workflow_id}`);
  }
  if (state.condition !== 'TERMINAL') {
    if (state.revision !== 1) throw new Error(`partial tombstone has unexpected revision: ${report.workflow_id}`);
    repository.apply({
      schema_version: 1, command_id: `CMD-${report.migration_id}-${report.workflow_id}-QUARANTINE`, workflow_id: report.workflow_id,
      expected_revision: 1, command_type: 'QUARANTINE', actor: 'legacy-migration', occurred_at: report.created_at,
      reason: 'Legacy evidence is preserved in a read-only archive; missing or invalid history is not reconstructed.',
      payload: {
        migration_id: report.migration_id, archive_workflow_root_abs: report.archive_workflow_root_abs,
        control_tree_sha256: report.control_tree_sha256, trusted_prefix_revision: report.event_chain.trusted_prefix_revision,
        observed_candidate_commit: report.source_snapshot.candidate_commit, candidate_trust: report.candidate_trust,
      },
    });
    state = repository.get(report.workflow_id);
  }
  if (state.outcome !== 'QUARANTINED') throw new Error(`existing v2 workflow has a conflicting terminal outcome: ${report.workflow_id}`);
  database.exec('BEGIN IMMEDIATE');
  try {
    const prior = database.prepare('SELECT report_json FROM legacy_quarantines WHERE workflow_id = ?').get(report.workflow_id);
    if (prior && canonicalJson(JSON.parse(prior.report_json)) !== canonicalJson(report)) throw new Error(`legacy report conflict: ${report.workflow_id}`);
    if (!prior) database.prepare(`INSERT INTO legacy_quarantines(workflow_id, migration_id, control_tree_sha256,
      artifact_tree_sha256, archive_root_abs, report_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(report.workflow_id, report.migration_id, report.control_tree_sha256, report.artifact_tree_sha256,
        report.archive_workflow_root_abs, JSON.stringify(report), report.created_at);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return state;
}

function selectedWorkflows(runtimeRoot, ids) {
  const root = join(runtimeRoot, 'control', 'workflows');
  const available = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const selected = ids?.length ? ids : available;
  for (const id of selected) {
    safeId(id, 'WF');
    if (!available.includes(id)) throw new Error(`legacy workflow does not exist: ${id}`);
  }
  return selected;
}

export function planLegacyMigration({ projectRoot: projectRootInput, runtimeRoot: runtimeRootInput, migrationId, workflowIds, createdAt = new Date().toISOString() }) {
  const projectRoot = resolve(projectRootInput);
  const runtimeRoot = resolve(runtimeRootInput);
  safeId(migrationId, 'MIG');
  const archiveRoot = join(runtimeRoot, 'control', 'legacy-archive', 'v1', migrationId);
  const activeIndexPath = join(runtimeRoot, 'control', 'active-workflows.json');
  const activeIndex = existsSync(activeIndexPath) ? { path_abs: activeIndexPath, sha256: sha256(readFileSync(activeIndexPath)) } : null;
  const activeEntries = activeIndex ? new Map((jsonFile(activeIndexPath).workflows ?? []).map((entry) => [entry.workflow_id, entry])) : new Map();
  const reports = selectedWorkflows(runtimeRoot, workflowIds).map((workflowId) => {
    const controlRoot = join(runtimeRoot, 'control', 'workflows', workflowId);
    const artifactRoot = join(runtimeRoot, 'artifacts', workflowId);
    const control = inventoryTree(controlRoot);
    const artifacts = existsSync(artifactRoot) ? inventoryTree(artifactRoot) : null;
    const checked = attachCrossChecks(inspectSnapshot(controlRoot), inspectEvents(join(controlRoot, 'events.jsonl')), activeEntries.get(workflowId));
    return {
      schema_version: 1, migration_id: migrationId, workflow_id: workflowId,
      source_control_root_abs: controlRoot, archive_workflow_root_abs: join(archiveRoot, 'workflows', workflowId),
      control_tree_sha256: control.tree_sha256, artifact_tree_sha256: artifacts?.tree_sha256 ?? null,
      source_snapshot: checked.snapshot, event_chain: checked.events,
      candidate_trust: 'UNTRUSTED_OBSERVATION_ONLY', disposition: 'QUARANTINE_TOMBSTONE_ONLY', created_at: createdAt,
      _inventory: { control, artifacts },
    };
  });
  const schema = jsonFile(join(projectRoot, 'contracts', 'legacy-quarantine-report-v2.schema.json'));
  const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv); const validate = ajv.compile(schema);
  for (const report of reports) {
    const { _inventory: ignored, ...publicReport } = report;
    if (!validate(publicReport)) throw new Error(`generated migration report is invalid: ${JSON.stringify(validate.errors)}`);
  }
  return { ok: true, command: 'plan', project_root_abs: projectRoot, runtime_root_abs: runtimeRoot, migration_id: migrationId, archive_root_abs: archiveRoot, active_index: activeIndex, reports };
}

export function applyLegacyMigration(options) {
  const preliminaryArchive = join(resolve(options.runtimeRoot), 'control', 'legacy-archive', 'v1', options.migrationId);
  const existingManifest = join(preliminaryArchive, 'manifest.json');
  const normalizedOptions = existsSync(existingManifest) && !options.createdAt
    ? { ...options, createdAt: jsonFile(existingManifest).created_at }
    : options;
  const plan = planLegacyMigration(normalizedOptions);
  const database = openControlDatabase(resolve(options.databasePath ?? join(plan.runtime_root_abs, 'control', 'control.db')));
  try {
    initializeQuarantines(database);
    const repository = createControlRepository(plan.project_root_abs, database);
    mkdirSync(plan.archive_root_abs, { recursive: true });
    if (plan.active_index) {
      const destination = join(plan.archive_root_abs, 'active-workflows.json');
      if (!existsSync(destination)) writeDurableFile(destination, readFileSync(plan.active_index.path_abs));
      if (sha256(readFileSync(destination)) !== plan.active_index.sha256) throw new Error('archived active index hash mismatch');
    }
    const results = [];
    for (const item of plan.reports) {
      const { _inventory, ...report } = item;
      const archiveControl = join(report.archive_workflow_root_abs, 'control');
      archiveCopy(report.source_control_root_abs, archiveControl, _inventory.control);
      if (_inventory.artifacts) archiveCopy(_inventory.artifacts.root_abs, join(report.archive_workflow_root_abs, 'artifacts'), _inventory.artifacts);
      const reportPath = join(report.archive_workflow_root_abs, 'forensic-report.json');
      if (!existsSync(reportPath)) writeDurableFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { exclusive: true });
      else if (canonicalJson(jsonFile(reportPath)) !== canonicalJson(report)) throw new Error(`archived report conflict: ${report.workflow_id}`);
      const state = importTombstone(repository, database, report);
      makeReadOnly(report.archive_workflow_root_abs);
      results.push({ workflow_id: report.workflow_id, outcome: state.outcome, revision: state.revision, archive_workflow_root_abs: report.archive_workflow_root_abs });
    }
    const manifest = {
      schema_version: 1, migration_id: plan.migration_id, created_at: options.createdAt ?? plan.reports[0]?.created_at,
      source_active_index: plan.active_index, workflows: plan.reports.map(({ _inventory: ignored, ...report }) => ({
        workflow_id: report.workflow_id, control_tree_sha256: report.control_tree_sha256,
        artifact_tree_sha256: report.artifact_tree_sha256, report_path_abs: join(report.archive_workflow_root_abs, 'forensic-report.json'),
      })),
    };
    const manifestPath = join(plan.archive_root_abs, 'manifest.json');
    if (!existsSync(manifestPath)) writeDurableFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { exclusive: true });
    else if (canonicalJson(jsonFile(manifestPath)) !== canonicalJson(manifest)) throw new Error('migration manifest conflict');
    exportControlProjections(database, plan.runtime_root_abs);
    return { ok: true, command: 'apply', migration_id: plan.migration_id, archive_root_abs: plan.archive_root_abs, manifest_path_abs: manifestPath, results };
  } finally { database.close(); }
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    if (!tokens[index]?.startsWith('--') || tokens[index + 1] == null) throw new Error(`invalid argument: ${tokens[index] ?? ''}`);
    options[tokens[index].slice(2)] = tokens[index + 1];
  }
  return { command, options };
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const input = {
      projectRoot: resolve(options['project-root'] ?? process.cwd()), runtimeRoot: resolve(options['runtime-root']),
      databasePath: options.db ? resolve(options.db) : undefined, migrationId: options['migration-id'],
      workflowIds: options['workflow-ids'] ? options['workflow-ids'].split(',').filter(Boolean) : undefined,
      createdAt: options['created-at'],
    };
    const result = command === 'plan' ? planLegacyMigration(input) : command === 'apply' ? applyLegacyMigration(input) : null;
    if (!result) throw new Error('usage: migrate-legacy-v1.mjs <plan|apply> --runtime-root <abs> --migration-id <MIG-id> [--workflow-ids <id,id>] [--db <abs>]');
    const publicResult = command === 'plan' ? { ...result, reports: result.reports.map(({ _inventory: ignored, ...report }) => report) } : result;
    process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, command: process.argv[2] ?? null, errors: [{ code: 'LEGACY_MIGRATION_ERROR', message: error.message }] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
