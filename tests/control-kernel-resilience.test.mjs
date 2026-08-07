import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { exportControlProjections } from '../scripts/control-core/projections.mjs';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const KERNEL = join(ROOT, 'scripts', 'control-kernel.mjs');
const BUNDLE = 'c'.repeat(64);
const CAPABILITY = 'test-local-orchestrator-capability';

function command(workflowId, type, revision, overrides = {}) {
  return {
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
    expected_revision: revision, command_type: type, actor: 'manager-agent',
    occurred_at: new Date(Date.UTC(2026, 7, 5, 12, 0, revision)).toISOString(),
    reason: `${type} resilience test`, payload: {}, ...overrides,
  };
}

function bootstrap(repository, workflowId) {
  return repository.apply(command(workflowId, 'BOOTSTRAP', 0, {
    payload: { contract_set_id: 'contracts-p5-test', agent_bundle_id: BUNDLE },
  }));
}

function runKernel(args, { capability = CAPABILITY } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [KERNEL, ...args], { cwd: ROOT, windowsHide: true,
      env: capability ? { ...process.env, OPENCLAW_CONTROL_CAPABILITY: capability } : { ...process.env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      let value = null;
      try { value = JSON.parse(stdout); } catch { /* assertion reports raw output */ }
      resolveRun({ code, value, stdout, stderr });
    });
  });
}

test('direct Control Kernel mutation rejects a missing local Orchestrator capability and does not trust actor text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-authority-'));
  const databasePath = join(directory, 'control.db');
  const workflowId = 'WF-control-authority';
  try {
    const database = openControlDatabase(databasePath);
    bootstrap(createControlRepository(ROOT, database), workflowId);
    database.close();
    const commandPath = join(directory, 'command.json');
    writeFileSync(commandPath, `${JSON.stringify(command(workflowId, 'ADVANCE_PHASE', 1, { actor: 'manager-agent', target_phase: 'REQUIREMENTS' }))}\n`);
    const capabilityPath = join(directory, 'orchestrator.capability');
    writeFileSync(capabilityPath, `${CAPABILITY}\n`);
    const result = await runKernel(['apply', '--project-root', ROOT, '--db', databasePath, '--command-file', commandPath,
      '--capability-file', capabilityPath], { capability: null });
    assert.equal(result.code, 1);
    assert.equal(result.value.errors[0].code, 'CONTROL_CALLER_UNAUTHORIZED');
    const reopened = openControlDatabase(databasePath);
    try { assert.equal(createControlRepository(ROOT, reopened).get(workflowId).revision, 1); }
    finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent commands on one workflow enforce CAS with one winner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-cas-'));
  const databasePath = join(directory, 'control.db');
  const workflowId = 'WF-p5-same-workflow';
  try {
    const database = openControlDatabase(databasePath);
    bootstrap(createControlRepository(ROOT, database), workflowId);
    database.close();
    const files = [0, 1].map((index) => {
      const path = join(directory, `command-${index}.json`);
      writeFileSync(path, `${JSON.stringify(command(workflowId, 'ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' }), null, 2)}\n`);
      return path;
    });
    const capabilityPath = join(directory, 'orchestrator.capability');
    writeFileSync(capabilityPath, `${CAPABILITY}\n`);
    const results = await Promise.all(files.map((path) => runKernel(['apply', '--project-root', ROOT, '--db', databasePath, '--command-file', path, '--capability-file', capabilityPath])));
    assert.deepEqual(results.map((item) => item.code).sort(), [0, 1]);
    assert.equal(results.filter((item) => item.value?.ok).length, 1);
    assert.ok(results.some((item) => item.value?.errors?.[0]?.code === 'CONTROL_REVISION_CONFLICT'));
    const reopened = openControlDatabase(databasePath);
    try {
      const repository = createControlRepository(ROOT, reopened);
      assert.equal(repository.get(workflowId).revision, 2);
      assert.equal(repository.events(workflowId).length, 2);
      assert.equal(auditControlDatabase(reopened).ok, true);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent different workflows retain both active states', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-multi-cas-'));
  const databasePath = join(directory, 'control.db');
  const runtime = join(directory, 'runtime');
  const ids = ['WF-p5-parallel-a', 'WF-p5-parallel-b'];
  try {
    const database = openControlDatabase(databasePath);
    const repository = createControlRepository(ROOT, database);
    for (const id of ids) bootstrap(repository, id);
    database.close();
    const files = ids.map((id) => {
      const path = join(directory, `${id}.json`);
      writeFileSync(path, `${JSON.stringify(command(id, 'ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' }), null, 2)}\n`);
      return path;
    });
    const capabilityPath = join(directory, 'orchestrator.capability');
    writeFileSync(capabilityPath, `${CAPABILITY}\n`);
    const results = await Promise.all(files.map((path) => runKernel(['apply', '--project-root', ROOT, '--db', databasePath, '--command-file', path, '--capability-file', capabilityPath])));
    assert.ok(results.every((item) => item.code === 0 && item.value?.ok));
    const reopened = openControlDatabase(databasePath);
    try {
      exportControlProjections(reopened, runtime);
      const active = JSON.parse(readFileSync(join(runtime, 'control', 'v2', 'active-workflows.json'), 'utf8'));
      assert.deepEqual(active.workflows.map((item) => item.workflow_id), ids);
      assert.ok(active.workflows.every((item) => item.revision === 2));
      assert.equal(auditControlDatabase(reopened, { runtimeRoot: runtime, projections: true }).ok, true);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('projection high-watermark never acknowledges a concurrent newer revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-high-water-'));
  const databasePath = join(directory, 'control.db');
  const runtime = join(directory, 'runtime');
  const workflowId = 'WF-p5-high-water';
  const first = openControlDatabase(databasePath);
  const second = openControlDatabase(databasePath);
  try {
    bootstrap(createControlRepository(ROOT, first), workflowId);
    const secondRepository = createControlRepository(ROOT, second);
    exportControlProjections(first, runtime, {
      beforeOutboxCommit() { secondRepository.apply(command(workflowId, 'ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' })); },
    });
    const rows = first.prepare('SELECT revision, status FROM projection_outbox WHERE workflow_id=? ORDER BY revision').all(workflowId).map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ revision: 1, status: 'APPLIED' }, { revision: 2, status: 'PENDING' }]);
    assert.equal(auditControlDatabase(first, { runtimeRoot: runtime, projections: true }).ok, false);
    exportControlProjections(first, runtime);
    assert.equal(auditControlDatabase(first, { runtimeRoot: runtime, projections: true }).ok, true);
  } finally {
    second.close(); first.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow transaction failpoints roll back before commit and replay after commit', () => {
  const before = openControlDatabase(':memory:');
  try {
    const workflowId = 'WF-p5-before-commit';
    const repository = createControlRepository(ROOT, before, { failpoint(name) { if (name === 'before-workflow-commit') throw new Error('simulated crash'); } });
    assert.throws(() => bootstrap(repository, workflowId), /simulated crash/);
    assert.equal(createControlRepository(ROOT, before).get(workflowId), null);
    assert.equal(before.prepare('SELECT COUNT(*) AS count FROM workflow_events').get().count, 0);
  } finally { before.close(); }

  const after = openControlDatabase(':memory:');
  try {
    const workflowId = 'WF-p5-after-commit';
    const original = command(workflowId, 'BOOTSTRAP', 0, { payload: { contract_set_id: 'contracts-p5-test', agent_bundle_id: BUNDLE } });
    const repository = createControlRepository(ROOT, after, { failpoint(name) { if (name === 'after-workflow-commit') throw new Error('simulated response loss'); } });
    assert.throws(() => repository.apply(original), /simulated response loss/);
    const recovered = createControlRepository(ROOT, after).apply(original);
    assert.equal(recovered.idempotent_replay, true);
    assert.equal(recovered.state.revision, 1);
    assert.equal(auditControlDatabase(after).ok, true);
  } finally { after.close(); }
});

test('projection failure leaves durable work for deterministic recovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-projection-fail-'));
  const runtime = join(directory, 'runtime');
  const database = openControlDatabase(join(directory, 'control.db'));
  try {
    bootstrap(createControlRepository(ROOT, database), 'WF-p5-projection-fail');
    assert.throws(() => exportControlProjections(database, runtime, { beforeOutboxCommit() { throw new Error('simulated projection crash'); } }), /simulated projection crash/);
    assert.equal(database.prepare('SELECT status FROM projection_outbox').get().status, 'FAILED');
    assert.equal(auditControlDatabase(database).ok, true);
    exportControlProjections(database, runtime);
    assert.equal(database.prepare('SELECT status FROM projection_outbox').get().status, 'APPLIED');
    assert.equal(auditControlDatabase(database, { runtimeRoot: runtime, projections: true }).ok, true);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('end-to-end v2 workflow remains recoverable after process restart and projection loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'control-e2e-'));
  const databasePath = join(directory, 'control.db');
  const runtime = join(directory, 'runtime');
  const workflowId = 'WF-p5-e2e';
  const phases = [
    'REQUIREMENTS', 'REQUIREMENT_GATE', 'ARCHITECTURE', 'ARCHITECTURE_GATE', 'DEVELOPMENT',
    'CODE_REVIEW', 'TESTING', 'TEST_CODE_REVIEW', 'RELEASE_VERIFICATION', 'FINAL_REPORT',
  ];
  try {
    let database = openControlDatabase(databasePath);
    let repository = createControlRepository(ROOT, database);
    bootstrap(repository, workflowId);
    let revision = 1;
    for (const phase of phases) {
      repository.apply(command(workflowId, 'ADVANCE_PHASE', revision, { target_phase: phase }));
      revision += 1;
    }
    repository.apply(command(workflowId, 'SET_CANDIDATE', revision, { candidate_commit: '0123456789abcdef' }));
    revision += 1;
    repository.apply(command(workflowId, 'COMPLETE', revision, { outcome: 'READY_FOR_OPERATIONS_HANDOFF' }));
    exportControlProjections(database, runtime);
    assert.equal(auditControlDatabase(database, { runtimeRoot: runtime, projections: true }).ok, true);
    database.close();

    rmSync(join(runtime, 'control', 'v2'), { recursive: true, force: true });
    database = openControlDatabase(databasePath);
    repository = createControlRepository(ROOT, database);
    assert.equal(repository.get(workflowId).outcome, 'READY_FOR_OPERATIONS_HANDOFF');
    assert.equal(auditControlDatabase(database).ok, true);
    exportControlProjections(database, runtime);
    const recovered = auditControlDatabase(database, { runtimeRoot: runtime, projections: true });
    assert.equal(recovered.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(runtime, 'control', 'v2', 'active-workflows.json'), 'utf8')).workflows, []);
    database.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
