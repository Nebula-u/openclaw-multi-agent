import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../scripts/runtime-core/atomic-store.mjs';
import { applyLegacyMigration, inventoryTree, planLegacyMigration } from '../scripts/migrate-legacy-v1.mjs';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ZERO = '0'.repeat(64);
const CREATED = '2026-08-05T10:00:00.000Z';

function event(workflowId, seq, previous, overrides = {}) {
  const value = {
    schema_version: 1, event_id: `EVT-${seq}`, timestamp: CREATED, workflow_id: workflowId,
    task_id: null, run_id: null, actor: 'manager-agent', event_type: 'LEGACY_EVENT',
    from_status: seq === 1 ? null : 'RUNNING', to_status: 'RUNNING', from_phase: null, to_phase: 'DEVELOPMENT',
    task_status_before: null, task_status_after: null, candidate_commit: 'observed-only', payload: {},
    seq, state_revision: seq, previous_event_hash: previous, ...overrides,
  };
  value.event_hash = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return value;
}

function fixture() {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'legacy-migration-'));
  const ids = ['WF-legacy-valid', 'WF-legacy-broken'];
  mkdirSync(join(runtimeRoot, 'control', 'workflows'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'artifacts'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'control', 'active-workflows.json'), `${JSON.stringify({ schema_version: 1, workflows: [{ workflow_id: ids[1], state_revision: 9 }] })}\n`);
  for (const id of ids) {
    const control = join(runtimeRoot, 'control', 'workflows', id);
    const artifacts = join(runtimeRoot, 'artifacts', id);
    mkdirSync(control, { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(control, 'workflow.json'), `${JSON.stringify({ workflow_id: id, status: 'RUNNING', current_phase: 'DEVELOPMENT', state_revision: id.endsWith('broken') ? 9 : 2, current_candidate_commit: 'deadbeef' })}\n`);
    const first = event(id, 1, ZERO);
    const second = event(id, 2, first.event_hash, id.endsWith('broken') ? { previous_event_hash: 'f'.repeat(64) } : {});
    writeFileSync(join(control, 'events.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    writeFileSync(join(artifacts, 'evidence.txt'), `evidence for ${id}\n`);
  }
  return { runtimeRoot, ids, close() { rmSync(runtimeRoot, { recursive: true, force: true }); } };
}

test('legacy migration plan is read-only and reports the trusted event prefix', () => {
  const value = fixture();
  try {
    const plan = planLegacyMigration({ projectRoot: ROOT, runtimeRoot: value.runtimeRoot, migrationId: 'MIG-test-plan', workflowIds: value.ids, createdAt: CREATED });
    assert.equal(plan.reports[0].event_chain.trusted_prefix_revision, 2);
    assert.equal(plan.reports[0].event_chain.snapshot_revision_matches, true);
    assert.equal(plan.reports[1].event_chain.trusted_prefix_revision, 1);
    assert.equal(plan.reports[1].event_chain.snapshot_revision_matches, false);
    assert.equal(plan.reports[1].source_snapshot.claimed_revision, 9);
    assert.equal(plan.reports[1].source_snapshot.active_index_matches_snapshot, false);
    assert.equal(plan.reports[1].candidate_trust, 'UNTRUSTED_OBSERVATION_ONLY');
    assert.equal(plan.reports[1].disposition, 'QUARANTINE_TOMBSTONE_ONLY');
    assert.equal(inventoryTree(join(value.runtimeRoot, 'control', 'workflows', value.ids[0])).tree_sha256, plan.reports[0].control_tree_sha256);
    assert.throws(() => readFileSync(join(plan.archive_root_abs, 'manifest.json')));
  } finally { value.close(); }
});

test('legacy migration archives exact evidence and imports only idempotent quarantine tombstones', () => {
  const value = fixture();
  try {
    const before = value.ids.map((id) => inventoryTree(join(value.runtimeRoot, 'control', 'workflows', id)).tree_sha256);
    const options = { projectRoot: ROOT, runtimeRoot: value.runtimeRoot, migrationId: 'MIG-test-apply', workflowIds: value.ids, createdAt: CREATED };
    const applied = applyLegacyMigration(options);
    assert.equal(applied.results.length, 2);
    const database = openControlDatabase(join(value.runtimeRoot, 'control', 'control.db'));
    try {
      const repository = createControlRepository(ROOT, database);
      for (const id of value.ids) {
        const state = repository.get(id);
        assert.equal(state.condition, 'TERMINAL');
        assert.equal(state.outcome, 'QUARANTINED');
        assert.equal(state.current_candidate_commit, null);
        assert.equal(state.revision, 2);
      }
      const report = JSON.parse(database.prepare('SELECT report_json FROM legacy_quarantines WHERE workflow_id = ?').get(value.ids[1]).report_json);
      assert.equal(report.event_chain.trusted_prefix_revision, 1);
      assert.equal(report.source_snapshot.candidate_commit, 'deadbeef');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM legacy_quarantines').get().count, 2);
    } finally { database.close(); }
    assert.deepEqual(value.ids.map((id) => inventoryTree(join(value.runtimeRoot, 'control', 'workflows', id)).tree_sha256), before);
    for (let index = 0; index < value.ids.length; index += 1) {
      const archived = inventoryTree(join(applied.archive_root_abs, 'workflows', value.ids[index], 'control'));
      assert.equal(archived.tree_sha256, before[index]);
    }
    const replay = applyLegacyMigration({ projectRoot: ROOT, runtimeRoot: value.runtimeRoot, migrationId: 'MIG-test-apply', workflowIds: value.ids });
    assert.equal(replay.results.length, 2);
  } finally { value.close(); }
});
