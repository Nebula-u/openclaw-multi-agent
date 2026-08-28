import assert from 'node:assert/strict';
import { dirname, join, relative, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { ingestTaskOutput } from '../scripts/orchestrator/output-ingestion.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';
import { sha256File } from '../scripts/runtime-core/atomic-store.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function field(message, name) {
  return message.match(new RegExp(`^- ${name}: (.+)$`, 'mu'))?.[1] ?? null;
}

function testRoute(workflowId) {
  return {
    schema_version: 1, workflow_id: workflowId, request_class: 'TEST_ONLY', summary: 'Run the assigned tests.', display_title: 'Tests', risk_flags: [],
    steps: [{ step_id: 'test', kind: 'TEST', title: 'Run tests', rationale: 'Verify the assigned repository.', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required for this test-only workflow.' })),
  };
}

async function createTestWorkflow(t, { runner, testSandboxStager, snapshots = null, testSandboxEnabled = true }) {
  const workflowId = `WF-TestSandbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runtimeRoot = join(ROOT, 'runtime', 'test-sandbox-workflows', workflowId);
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => {
    database.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const orchestrator = createOrchestrator({
    projectRoot: ROOT, runtimeRoot, database, runner, testSandboxStager, testSandboxEnabled,
    worktrees: {
      inspectTarget(targetProjectRootAbs) { return { targetProjectRootAbs, headCommit: '1'.repeat(40) }; },
      prepare() { return { worktreePathAbs: ROOT, inputCommit: '1'.repeat(40) }; },
    },
    snapshots: snapshots ?? {
      async recover(input) { return { ...input, snapshotId: 'SNP-test', snapshotKind: 'NO_CHANGE', outputCommit: input.inputCommit, changeSummary: {} }; },
    },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await orchestrator.createRun({
    schema_version: 1, request_id: `REQ-${workflowId}`, request_type: 'CREATE', workflow_id: workflowId, submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:test', project_path_abs: ROOT,
    original_request: 'Run the assigned tests in the isolated staging workspace.', route_plan: testRoute(workflowId),
    user_authorized: { confirmed: true, actor: 'human:test', message: 'Run it.' },
  });
  return { workflowId, orchestrator };
}

function blockedTestResult(task, { inputCommit = task.inputCommit } = {}) {
  return {
    schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId,
    role: 'tester', attempt: task.attempt, started_at: '2026-08-21T00:00:00.000Z', finished_at: '2026-08-21T00:01:00.000Z',
    result_status: 'BLOCKED', summary_for_user: 'The assigned test could not complete.', summary_for_manager: 'The test task is blocked.',
    worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs, input_commit: inputCommit, output_commit: task.inputCommit,
    isolation_mode: 'SANDBOXED_DOCKER', sandbox_attestation: { backend: 'test-double' },
    self_validation: { preflight_passed: false, checks: [] }, artifact_manifest_hash: task.contextManifestSha256,
  };
}

test('disabled TEST sandbox dispatches the assigned local worktree without staging or attestation', async (t) => {
  const calls = { prepare: 0, collect: 0, cleanup: 0, runner: 0 };
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxEnabled: false,
    testSandboxStager: {
      prepare() { calls.prepare += 1; throw new Error('sandbox must not be prepared when disabled'); },
      collect() { calls.collect += 1; },
      cleanup() { calls.cleanup += 1; },
    },
    runner: async ({ messagePath }) => {
      calls.runner += 1;
      const message = readFileSync(messagePath, 'utf8');
      assert.equal(field(message, 'worktree_path_abs'), ROOT);
      assert.equal(field(message, 'context_manifest_path_abs')?.endsWith('context-manifest.json'), true);
      assert.doesNotMatch(message, /execution_worktree_path_abs|\.task-sandbox|result_identity/u);
      const rawOutputPath = message.match(/Write exactly one result\.schema\.json object only to:\r?\n\r?\n([^\r\n]+)/u)?.[1];
      assert.ok(rawOutputPath);
      mkdirSync(dirname(rawOutputPath), { recursive: true });
      writeFileSync(rawOutputPath, `${JSON.stringify({
        ...blockedTestResult({
          workflowId: field(message, 'workflow_id'), taskId: field(message, 'task_id'), runId: field(message, 'run_id'), agentId: field(message, 'assigned_agent'),
          attempt: Number(field(message, 'attempt')), worktreePathAbs: field(message, 'worktree_path_abs'), artifactRootAbs: dirname(dirname(rawOutputPath)),
          inputCommit: '1'.repeat(40), contextManifestSha256: field(message, 'context_manifest_sha256'),
        }),
        isolation_mode: 'UNSANDBOXED_LOCAL', sandbox_attestation: null,
      })}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  assert.equal(result.state, 'FAILED');
  assert.deepEqual(calls, { prepare: 0, collect: 0, cleanup: 0, runner: 1 });
  assert.equal(task.payload.result.isolation_mode, 'UNSANDBOXED_LOCAL');
  assert.equal(task.payload.result.sandbox_attestation, null);
});

function hostSandboxAttestation(task) {
  const receiptPathAbs = join(task.artifactRootAbs, '.orchestrator', 'test-sandbox-attestation.receipt.json');
  mkdirSync(dirname(receiptPathAbs), { recursive: true });
  writeFileSync(receiptPathAbs, `${JSON.stringify({
    schema_version: 1, kind: 'test-sandbox-attestation', authority: 'orchestrator-host',
    workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId, attempt: task.attempt,
    verification: { effective_openclaw_configuration: true, staging_workspace: true, runtime_container_inspected: false },
    configured_sandbox: { backend: 'docker', image: 'openclaw-test-node:22-slim', network: 'none', read_only_root: true, cap_drop: ['ALL'] },
    limitations: ['OpenClaw does not expose a per-run container ID; the host did not inspect a runtime container.'],
  }, null, 2)}\n`);
  return { receipt_path_abs: receiptPathAbs, receipt_sha256: sha256File(receiptPathAbs) };
}

test('human-decision output keeps the run waiting and records a recovery snapshot', async (t) => {
  const workflowId = `WF-Human-${Date.now()}`;
  const artifactRoot = join(ROOT, 'runtime', 'artifacts', workflowId);
  let generatedArtifactRoot = null;
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => {
    database.close();
    rmSync(artifactRoot, { recursive: true, force: true });
    if (generatedArtifactRoot) rmSync(generatedArtifactRoot, { recursive: true, force: true });
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
  generatedArtifactRoot = task.payload.artifact_root_abs;
  assert.equal(relative(join(ROOT, 'work'), generatedArtifactRoot).startsWith('..'), false);
  assert.doesNotMatch(generatedArtifactRoot, /runtime[\\/]artifacts/u);
});

test('TEST workflow dispatches only staged paths, collects staged output, and records BLOCKED with host identity', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-success', `${Date.now()}-${Math.random().toString(16).slice(2)}`, '.task-sandbox');
  const calls = { prepare: 0, collect: 0, cleanup: 0, runner: 0 };
  let stagedTask;
  const staging = {
    executionRootAbs: stageRoot,
    executionWorktreeAbs: join(stageRoot, 'repo'),
    executionContextManifestPathAbs: join(stageRoot, 'input', 'execution-context-manifest.json'),
    executionOutputRootAbs: join(stageRoot, 'output'),
    executionRawLogsRootAbs: join(stageRoot, 'raw-logs'),
    executionRawOutputPath: join(stageRoot, 'output', 'result.json.raw'),
    containerWorktreeAbs: '/workspace/.task-sandbox/repo',
    containerContextManifestPathAbs: '/workspace/.task-sandbox/input/execution-context-manifest.json',
    containerRawOutputPath: '/workspace/.task-sandbox/output/result.json.raw',
  };
  t.after(() => rmSync(stageRoot, { recursive: true, force: true }));
  const testSandboxStager = {
    prepare(task) { calls.prepare += 1; stagedTask = task; mkdirSync(dirname(staging.executionRawOutputPath), { recursive: true }); staging.attestation = hostSandboxAttestation(task); return staging; },
    collect(task, value) { calls.collect += 1; assert.equal(value, staging); mkdirSync(dirname(task.rawOutputPath), { recursive: true }); copyFileSync(value.executionRawOutputPath, task.rawOutputPath); return { referencePathMappings: [] }; },
    cleanup(value) { calls.cleanup += 1; assert.equal(value, staging); rmSync(stageRoot, { recursive: true, force: true }); },
  };
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager,
    runner: async ({ messagePath }) => {
      calls.runner += 1;
      const message = readFileSync(messagePath, 'utf8');
      assert.match(message, /execution_worktree_path_abs: \/workspace\/.task-sandbox\/repo/u);
      assert.match(message, /execution_context_manifest_path_abs: \/workspace\/.task-sandbox\/input\/execution-context-manifest\.json/u);
      assert.match(message, /Write exactly one result\.schema\.json object only to:[\s\S]*\/workspace\/.task-sandbox\/output\/result\.json\.raw/u);
      assert.doesNotMatch(message, /host_worktree_path_abs|host_artifact_root_abs/u);
      writeFileSync(staging.executionRawOutputPath, `${JSON.stringify(blockedTestResult(stagedTask))}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.state, 'FAILED');
  assert.equal(task.payload.result.result_status, 'BLOCKED');
  assert.equal(task.payload.result.input_commit, '1'.repeat(40));
  assert.equal(existsSync(task.payload.ingestion_receipt_path_abs), true);
  assert.equal(readFileSync(join(task.payload.artifact_root_abs, '.agent-raw', 'result.json.raw'), 'utf8'), JSON.stringify(blockedTestResult(stagedTask)) + '\n');
  assert.deepEqual(calls, { prepare: 1, collect: 1, cleanup: 1, runner: 1 });
  assert.equal(execution.state, 'FAILED');
});

test('TEST workflow imports a validated staged commit before snapshot acceptance', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-commit', `${Date.now()}-${Math.random().toString(16).slice(2)}`, '.task-sandbox');
  const outputCommit = '2'.repeat(40);
  let imported = false;
  let stagedTask;
  const staging = {
    executionWorktreeAbs: join(stageRoot, 'repo'), executionContextManifestPathAbs: join(stageRoot, 'input', 'execution-context-manifest.json'),
    executionRawOutputPath: join(stageRoot, 'output', 'result.json.raw'), containerWorktreeAbs: '/workspace/.task-sandbox/repo',
    containerContextManifestPathAbs: '/workspace/.task-sandbox/input/execution-context-manifest.json', containerRawOutputPath: '/workspace/.task-sandbox/output/result.json.raw',
  };
  t.after(() => rmSync(stageRoot, { recursive: true, force: true }));
  const sandboxStager = {
    prepare(task) {
      stagedTask = task;
      mkdirSync(dirname(staging.executionRawOutputPath), { recursive: true });
      staging.attestation = hostSandboxAttestation(task);
      return staging;
    },
    collect(task) {
      mkdirSync(dirname(task.rawOutputPath), { recursive: true });
      copyFileSync(staging.executionRawOutputPath, task.rawOutputPath);
      return { referencePathMappings: [] };
    },
    integrateCommit(task, value, commit) {
      assert.equal(task, stagedTask); assert.equal(value, staging); assert.equal(commit, outputCommit); imported = true;
      return { inputCommit: task.inputCommit, outputCommit: commit, changedPaths: ['tests/new.test.js'] };
    },
    cleanup() { rmSync(stageRoot, { recursive: true, force: true }); },
  };
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager: sandboxStager,
    snapshots: {
      async accept(input) {
        assert.equal(imported, true, 'staged commit must be canonical before snapshot acceptance');
        assert.equal(input.outputCommit, outputCommit);
        return { ...input, snapshotId: 'SNP-imported', snapshotKind: 'ACCEPTED', changeSummary: { added: ['tests/new.test.js'] } };
      },
      async recover() { throw new Error('not reached'); },
    },
    runner: async () => {
      writeFileSync(staging.executionRawOutputPath, `${JSON.stringify({
        ...blockedTestResult(stagedTask), result_status: 'COMPLETED', summary_for_user: 'Tests passed.', summary_for_manager: 'Tests passed.',
        output_commit: outputCommit, self_validation: { preflight_passed: true, checks: [] },
      })}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const result = await orchestrator.tick(workflowId);
  assert.equal(result.state, 'TERMINAL');
  assert.equal(imported, true);
});

test('TEST runner error cleans staged workspace and releases its execution lease', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-runner-error', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const calls = { prepare: 0, collect: 0, cleanup: 0, runner: 0 };
  const staging = {
    executionWorktreeAbs: join(stageRoot, 'repo'), executionContextManifestPathAbs: join(stageRoot, 'input', 'execution-context-manifest.json'),
    executionRawOutputPath: join(stageRoot, 'output', 'result.json.raw'), containerWorktreeAbs: '/workspace/.task-sandbox/repo',
    containerContextManifestPathAbs: '/workspace/.task-sandbox/input/execution-context-manifest.json', containerRawOutputPath: '/workspace/.task-sandbox/output/result.json.raw',
  };
  t.after(() => rmSync(stageRoot, { recursive: true, force: true }));
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager: {
      prepare() { calls.prepare += 1; mkdirSync(stageRoot, { recursive: true }); return staging; },
      collect() { calls.collect += 1; },
      cleanup() { calls.cleanup += 1; rmSync(stageRoot, { recursive: true, force: true }); },
    },
    runner: async () => { calls.runner += 1; throw Object.assign(new Error('runner exploded'), { code: 'RUNNER_EXPLODED' }); },
  });
  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.lastError.code, 'RUNNER_EXPLODED');
  assert.deepEqual(calls, { prepare: 1, collect: 0, cleanup: 1, runner: 1 });
  assert.equal(existsSync(stageRoot), false);
  assert.equal(execution.state, 'FAILED');
});

test('BLOCKED TEST output still requires the assigned input commit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-blocked-input-'));
  const task = {
    workflowId: 'WF-Blocked-Identity', taskId: 'TASK-Blocked-Identity', runId: 'RUN-Blocked-Identity', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify(blockedTestResult(task, { inputCommit: 'UNKNOWN' }))}\n`);

  assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task, sandboxContext: { attestation: hostSandboxAttestation(task), referencePathMappings: [] } }),
    (error) => error.code === 'AGENT_OUTPUT_INPUT_COMMIT_MISMATCH');
});

test('TEST ingestion verifies the host receipt and maps collected execution evidence paths before boundary validation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-ingest-map-'));
  const task = {
    kind: 'TEST', workflowId: 'WF-Test-Ingest', taskId: 'TASK-Test-Ingest', runId: 'RUN-Test-Ingest', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(task.worktreePathAbs, { recursive: true });
  const hostLogs = join(task.artifactRootAbs, 'raw-logs');
  mkdirSync(hostLogs, { recursive: true });
  for (const [name, content] of [['test.stdout.log', 'ok\n'], ['command-records.jsonl', '{}\n'], ['evidence.jsonl', '{}\n'], ['claim-evidence.jsonl', '{}\n']]) writeFileSync(join(hostLogs, name), content);
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  const result = {
    ...blockedTestResult(task), result_status: 'COMPLETED', summary_for_user: 'Tests passed.', summary_for_manager: 'Tests passed.',
    self_validation: { preflight_passed: true, checks: [] },
    sandbox_attestation: { backend: 'agent-claimed-docker', container_id: 'untrusted-claim' },
    report_files: ['/workspace/.task-sandbox/raw-logs/test.stdout.log'],
    command_record_refs: ['/workspace/.task-sandbox/raw-logs/command-records.jsonl'],
    evidence_refs: ['/workspace/.task-sandbox/raw-logs/evidence.jsonl'],
    claims: [{ claim_id: 'CLAIM-1', statement: 'The test passed.', classification: 'OBSERVED',
      evidence_refs: ['/workspace/.task-sandbox/raw-logs/claim-evidence.jsonl'] }],
  };
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify(result)}\n`);
  const attestation = hostSandboxAttestation(task);

  const ingested = ingestTaskOutput({ projectRoot: ROOT, task, sandboxContext: {
    attestation,
    referencePathMappings: [{ container_root_abs: '/workspace/.task-sandbox/raw-logs', host_root_abs: hostLogs }],
  } });

  assert.deepEqual(ingested.value.report_files, [join(hostLogs, 'test.stdout.log')]);
  assert.deepEqual(ingested.value.command_record_refs, [join(hostLogs, 'command-records.jsonl')]);
  assert.deepEqual(ingested.value.evidence_refs, [join(hostLogs, 'evidence.jsonl')]);
  assert.deepEqual(ingested.value.claims[0].evidence_refs, [join(hostLogs, 'claim-evidence.jsonl')]);
  assert.equal(ingested.value.sandbox_attestation.authority, 'orchestrator-host');
  assert.equal(ingested.value.sandbox_attestation.receipt_path_abs, attestation.receipt_path_abs);
  assert.equal(ingested.value.sandbox_attestation.runtime_container_inspected, false);
  assert.deepEqual(ingested.value.sandbox_attestation.agent_claim, result.sandbox_attestation);
  assert.equal(ingested.artifacts.some((artifact) => artifact.path_abs === attestation.receipt_path_abs && artifact.sha256 === attestation.receipt_sha256), true);
  assert.doesNotMatch(readFileSync(ingested.outputPath, 'utf8'), /\/workspace\/\.task-sandbox\/raw-logs/u);
});

test('reference mapping preserves absent arrays and records no mapping transformation when no reference changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-ingest-no-map-'));
  const task = {
    kind: 'TEST', workflowId: 'WF-Test-No-Map', taskId: 'TASK-Test-No-Map', runId: 'RUN-Test-No-Map', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify(blockedTestResult(task))}\n`);
  const attestation = hostSandboxAttestation(task);

  const ingested = ingestTaskOutput({ projectRoot: ROOT, task, sandboxContext: { attestation, referencePathMappings: [] } });

  for (const field of ['report_files', 'command_record_refs', 'evidence_refs']) assert.equal(Object.hasOwn(ingested.value, field), false);
  const receipt = JSON.parse(readFileSync(ingested.receiptPath, 'utf8'));
  assert.equal(receipt.transformations.includes('container_references_mapped'), false);
});

test('TEST ingestion fails closed when a host attestation receipt is missing or changed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-ingest-attestation-'));
  const task = {
    kind: 'TEST', workflowId: 'WF-Test-Attestation', taskId: 'TASK-Test-Attestation', runId: 'RUN-Test-Attestation', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify(blockedTestResult(task))}\n`);
  assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task }), (error) => error.code === 'TEST_SANDBOX_ATTESTATION_MISSING');
  const attestation = hostSandboxAttestation(task);
  writeFileSync(attestation.receipt_path_abs, '{}\n');
  assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task, sandboxContext: { attestation, referencePathMappings: [] } }),
    (error) => error.code === 'TEST_SANDBOX_ATTESTATION_HASH_MISMATCH');
});

test('staged TEST ingestion rejects an agent attempt to downgrade the isolation mode', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-test-isolation-downgrade-'));
  const task = {
    kind: 'TEST', workflowId: 'WF-Test-Isolation', taskId: 'TASK-Test-Isolation', runId: 'RUN-Test-Isolation', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify({
    ...blockedTestResult(task), isolation_mode: 'UNSANDBOXED_LOCAL', sandbox_attestation: null,
  })}\n`);

  assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task, sandboxContext: {
    attestation: hostSandboxAttestation(task), referencePathMappings: [],
  } }), (error) => error.code === 'TEST_SANDBOX_ISOLATION_MISMATCH');
});

test('TEST staging preparation failure is recorded as BLOCKED, releases its lease, and never reaches the runner', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-prepare-error', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const lockPath = `${stageRoot}.lock`;
  let runnerCalls = 0;
  t.after(() => { rmSync(stageRoot, { recursive: true, force: true }); rmSync(lockPath, { force: true }); });
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager: {
      prepare() { mkdirSync(dirname(lockPath), { recursive: true }); writeFileSync(lockPath, 'locked'); unlinkSync(lockPath); throw Object.assign(new Error('staging unavailable'), { code: 'TEST_SANDBOX_INPUT_MISSING' }); },
      collect() { throw new Error('not reached'); }, cleanup() { throw new Error('not reached'); },
    },
    runner: async () => { runnerCalls += 1; return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.payload.result.result_status, 'BLOCKED');
  assert.equal(task.lastError.code, 'AGENT_BLOCKED');
  assert.equal(runnerCalls, 0);
  assert.equal(existsSync(lockPath), false);
  assert.equal(execution.state, 'FAILED');
});
