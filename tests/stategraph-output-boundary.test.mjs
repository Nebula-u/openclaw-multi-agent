import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ingestTaskOutput, rawOutputPath } from '../scripts/stategraph/output-ingestion.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stategraph-output-'));
  const artifact = join(root, 'artifact');
  const worktree = join(root, 'worktree');
  mkdirSync(join(artifact, '.agent-raw'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const task = {
    workflow_id: 'WF-output-boundary', task_id: 'TASK-output-boundary-dev', run_id: 'RUN-output-boundary-dev-A1',
    agent_id: 'developer-agent', attempt: 1, kind: 'DEVELOPMENT', artifact_root_abs: artifact,
    worktree_path_abs: worktree, input_commit: 'a'.repeat(40), context_manifest_sha256: 'b'.repeat(64),
  };
  const report = join(artifact, 'report.md');
  const stdout = join(artifact, 'stdout.log');
  const stderr = join(artifact, 'stderr.log');
  const observed = join(worktree, 'observed.txt');
  writeFileSync(report, 'report\n');
  writeFileSync(stdout, 'ok\n');
  writeFileSync(stderr, '');
  writeFileSync(observed, 'observed\n');
  const commands = join(artifact, 'command-records.jsonl');
  writeFileSync(commands, `${JSON.stringify({
    command_record_id: 'CMD-output-1', executable: 'node', argv: ['--version'], cwd_abs: worktree,
    started_at: '2026-08-14T00:00:00.000Z', finished_at: '2026-08-14T00:00:01.000Z', exit_code: 0, timed_out: false,
    stdout_path_abs: stdout, stderr_path_abs: stderr, stdout_sha256: digest('ok\n'), stderr_sha256: digest(''),
    attempt: 1, invoked_by_agent: 'developer-agent', task_id: task.task_id, run_id: task.run_id, isolation_mode: 'UNSANDBOXED_LOCAL',
  })}\n`);
  const evidence = join(artifact, 'evidence.jsonl');
  writeFileSync(evidence, `${JSON.stringify({
    evidence_id: 'EVD-output-1', source_type: 'file', locator_abs: observed, sha256: digest('observed\n'),
    collected_at: '2026-08-14T00:00:01.000Z', collector: 'developer-agent',
  })}\n`);
  const result = {
    schema_version: 1, workflow_id: task.workflow_id, task_id: task.task_id, run_id: task.run_id,
    agent_id: task.agent_id, role: 'worker', attempt: task.attempt,
    started_at: '2026-08-14T00:00:00.000Z', finished_at: '2026-08-14T00:00:01.000Z', result_status: 'COMPLETED',
    summary_for_user: '完成', summary_for_manager: '完成', worktree_path_abs: worktree, artifact_root_abs: artifact,
    input_commit: task.input_commit, output_commit: task.input_commit, isolation_mode: 'UNSANDBOXED_LOCAL',
    report_files: [report], command_record_refs: [commands], evidence_refs: [evidence],
    self_validation: { preflight_passed: true, checks: [] }, artifact_manifest_hash: task.context_manifest_sha256,
  };
  const writeResult = (value = result) => writeFileSync(rawOutputPath(task), JSON.stringify(value));
  return { root, task, result, report, stdout, stderr, observed, commands, evidence, writeResult };
}

test('ingestion records hashes for every accepted report, command record and evidence file', () => {
  const value = fixture();
  try {
    value.writeResult();
    const accepted = ingestTaskOutput({ projectRoot: ROOT, task: value.task });
    const receipt = JSON.parse(readFileSync(accepted.receipt_path_abs, 'utf8'));
    assert.equal(receipt.references.length, 3);
    assert.ok(receipt.references.every((reference) => /^[a-f0-9]{64}$/u.test(reference.sha256)));
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('ingestion fails closed when report, CommandRecord or evidence references are missing', () => {
  for (const field of ['report_files', 'command_record_refs', 'evidence_refs']) {
    const value = fixture();
    try {
      value.writeResult({ ...value.result, [field]: [join(value.task.artifact_root_abs, `missing-${field}`)] });
      assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task: value.task }), (error) => error.code === 'AGENT_OUTPUT_REFERENCE_MISSING');
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  }
});

test('ingestion rejects a symlinked report even when its target is inside the artifact root', (context) => {
  const value = fixture();
  try {
    const linked = join(value.task.artifact_root_abs, process.platform === 'win32' ? 'report-junction' : 'report-link.md');
    const target = process.platform === 'win32' ? join(value.task.artifact_root_abs, 'report-target') : value.report;
    if (process.platform === 'win32') mkdirSync(target);
    try { symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip(`symlinks unavailable: ${error.code}`); return; }
      throw error;
    }
    value.writeResult({ ...value.result, report_files: [linked] });
    assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task: value.task }), (error) => error.code === 'AGENT_OUTPUT_REFERENCE_UNSAFE');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('ingestion rejects a CommandRecord stream SHA that does not match the preserved raw log', () => {
  const value = fixture();
  try {
    const record = JSON.parse(readFileSync(value.commands, 'utf8'));
    writeFileSync(value.commands, `${JSON.stringify({ ...record, stdout_sha256: '0'.repeat(64) })}\n`);
    value.writeResult();
    assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task: value.task }), (error) => error.code === 'COMMAND_RECORD_STREAM_HASH_MISMATCH');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('ingestion rejects evidence whose declared SHA does not match locator_abs', () => {
  const value = fixture();
  try {
    const record = JSON.parse(readFileSync(value.evidence, 'utf8'));
    writeFileSync(value.evidence, `${JSON.stringify({ ...record, sha256: '0'.repeat(64) })}\n`);
    value.writeResult();
    assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task: value.task }), (error) => error.code === 'EVIDENCE_HASH_MISMATCH');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
