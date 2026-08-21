import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function field(message, name) {
  return message.match(new RegExp(`^- ${name}: (.+)$`, 'mu'))?.[1] ?? null;
}

test('human-decision output keeps the run waiting and records a recovery snapshot', async (t) => {
  const workflowId = `WF-Human-${Date.now()}`;
  const artifactRoot = join(ROOT, 'runtime', 'artifacts', workflowId);
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => {
    database.close();
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  const snapshots = [];
  const orchestrator = createOrchestrator({
    projectRoot: ROOT,
    database,
    worktrees: {
      inspectTarget(targetProjectRootAbs) {
        return { targetProjectRootAbs, headCommit: '1'.repeat(40) };
      },
      prepare() {
        return { worktreePathAbs: ROOT, inputCommit: '1'.repeat(40) };
      },
    },
    snapshots: {
      async recover(input) {
        const snapshot = { ...input, snapshotId: 'SNP-human', snapshotKind: 'NO_CHANGE', outputCommit: input.inputCommit, changeSummary: {} };
        snapshots.push(snapshot);
        return snapshot;
      },
    },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runner: async ({ messagePath }) => {
      const message = readFileSync(messagePath, 'utf8');
      const rawOutputPath = message.match(/Write exactly one result\.schema\.json object only to:\r?\n\r?\n([^\r\n]+)/u)?.[1];
      assert.ok(rawOutputPath, 'task message must expose the raw output path');
      const taskArtifactRoot = dirname(dirname(rawOutputPath));
      mkdirSync(dirname(rawOutputPath), { recursive: true });
      writeFileSync(rawOutputPath, `${JSON.stringify({
        schema_version: 1,
        workflow_id: field(message, 'workflow_id'),
        task_id: field(message, 'task_id'),
        run_id: field(message, 'run_id'),
        agent_id: field(message, 'assigned_agent'),
        role: 'reviewer',
        attempt: Number(field(message, 'attempt')),
        started_at: '2026-08-21T00:00:00.000Z',
        finished_at: '2026-08-21T00:01:00.000Z',
        result_status: 'HUMAN_DECISION_REQUIRED',
        summary_for_user: 'A human decision is required.',
        summary_for_manager: 'Wait for the bound Manager decision.',
        worktree_path_abs: field(message, 'worktree_path_abs'),
        artifact_root_abs: taskArtifactRoot,
        input_commit: '1'.repeat(40),
        output_commit: '1'.repeat(40),
        isolation_mode: 'UNSANDBOXED_LOCAL',
        self_validation: { preflight_passed: true, checks: [] },
        artifact_manifest_hash: field(message, 'context_manifest_sha256'),
        decisions_required: [{ summary: 'Choose whether to continue.' }],
      })}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await orchestrator.createRun({
    schema_version: 1,
    request_id: 'REQ-human',
    request_type: 'CREATE',
    workflow_id: workflowId,
    submitted_by: 'manager-agent',
    manager_session_id: 'manager-session',
    manager_session_key: 'agent:manager:test',
    project_path_abs: ROOT,
    original_request: 'Review the current implementation and stop for a decision.',
    route_plan: {
      schema_version: 1,
      workflow_id: workflowId,
      request_class: 'ANALYSIS_ONLY',
      summary: 'Review and request a human decision.',
      display_title: 'Review',
      risk_flags: [],
      steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', rationale: 'A decision is required.', human_approval_after: false, approval_reason: null }],
      skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required.' })),
    },
    user_authorized: { confirmed: true, actor: 'human:test', message: 'Run it.' },
  });

  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const diagnostic = JSON.stringify({ result, run, task }, null, 2);
  assert.equal(result.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(run.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(task.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(task.payload.snapshot.snapshotKind, 'NO_CHANGE');
  assert.equal(snapshots.length, 1);
});
