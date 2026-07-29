import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts', 'runtime-guard.mjs');
const WORKFLOW_ID = 'WF-00000000-0000-0000-0000-000000000001';
const TASK_ID = 'TASK-00000000-0000-0000-0000-000000000001';
const RUN_ID = 'RUN-00000000-0000-0000-0000-000000000001';
const ZERO_HASH = '0'.repeat(64);
const FIRST_EVENT_HASH = 'd42a3dbcacd494ced033f30a4818ca3a4941f8e76e44ce459782ef534dbe15e8';

function runGuard(args) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
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
    timestamp: `2026-07-29T00:00:0${fields.seq - 1}Z`,
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
  mkdirSync(join(workflowDir, 'tasks'), { recursive: true });
  mkdirSync(join(workflowDir, 'decisions'), { recursive: true });
  mkdirSync(join(workflowDir, 'gates'), { recursive: true });

  const workflow = {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    status,
    status_reason: 'test fixture',
    target_project_root_abs: targetRoot,
    runtime_root_abs: runtimeRoot,
    integration_branch: `sdlc/${WORKFLOW_ID}/integration`,
    base_commit: 'a'.repeat(40),
    current_candidate_commit: null,
    current_phase: phase,
    state_revision: revision,
    task_ids: taskIds,
    pending_decision_ids: pendingDecisionIds,
    context_version: 0,
    rules_version: 'test-rules-v1',
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
        current_candidate_commit: null,
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
    }),
  ];
  writeFileSync(
    join(workflowDir, 'events.jsonl'),
    `${actualEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );

  return {
    root,
    runtimeRoot,
    targetRoot,
    workflowDir,
    workflow,
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

function minimalTask(fixture, overrides = {}) {
  const artifactRoot = join(fixture.runtimeRoot, 'artifacts', WORKFLOW_ID, TASK_ID, RUN_ID);
  const task = {
    schema_version: 1,
    workflow_id: WORKFLOW_ID,
    task_id: TASK_ID,
    run_id: RUN_ID,
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
    approval_dependencies: [],
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:01Z',
    ...overrides,
  };
  writeJson(join(fixture.workflowDir, 'tasks', `${TASK_ID}.json`), task);
  return task;
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
  const fixture = makeRuntime({ taskIds: [TASK_ID] });
  try {
    const task = minimalTask(fixture);
    writeJson(join(task.artifact_root_abs, 'output', 'review-findings.json'), {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      reviewed_commit: 'b'.repeat(40),
      review_scope: 'PRODUCTION_CODE',
      verdict: 'REQUEST_CHANGES',
      findings: [
        {
          finding_id: 'FIND-0001',
          severity: 'HIGH',
          category: 'security',
          title: 'unsafe token storage',
          description: 'token stored in localStorage',
          file: 'src/auth.js',
          line: 10,
          commit: 'b'.repeat(40),
          evidence: [],
          remediation: 'use an HttpOnly cookie',
          blocking: true,
          status: 'OPEN',
        },
      ],
    });
    writeJson(join(fixture.workflowDir, 'gates', 'release-1.json'), {
      schema_version: 1,
      gate_id: 'GATE-REL-001',
      gate_name: 'ReleaseReadinessGate',
      workflow_id: WORKFLOW_ID,
      task_id: TASK_ID,
      checklist_version: 'gate-checklists v1',
      evaluated_at: '2026-07-29T00:00:01Z',
      items: [
        {
          item_id: 'REL-1',
          description: 'candidate matches',
          status: 'PASS',
          blocking: true,
          evidence_refs: [],
          notes: 'matched',
        },
      ],
      approved_decision_ids: [],
      overall: 'PASS',
      overall_reason: 'incorrectly ignored finding',
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
  const fixture = makeRuntime({ taskIds: [TASK_ID] });
  try {
    const task = minimalTask(fixture, { status: 'READY' });
    writeJson(join(task.artifact_root_abs, 'output', 'review-findings.json'), { schema_version: 1, workflow_id: WORKFLOW_ID, task_id: TASK_ID, reviewed_commit: 'b'.repeat(40), review_scope: 'PRODUCTION_CODE', verdict: 'REQUEST_CHANGES', findings: [{ finding_id: 'FIND-1', severity: 'HIGH', category: 'security', title: 't', description: 'd', blocking: false, status: 'OPEN' }] });
    writeJson(join(fixture.workflowDir, 'gates', 'gate.json'), { schema_version: 1, gate_id: 'GATE-001', gate_name: 'SecurityGate', workflow_id: WORKFLOW_ID, task_id: null, checklist_version: 'v1', evaluated_at: '2026-07-29T00:00:01Z', items: [{ item_id: 'I', description: 'd', status: 'PASS', blocking: false, evidence_refs: [], notes: '' }], approved_decision_ids: [], overall: 'PASS', overall_reason: 'x' });
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

test('check-workflow rejects a workflow directory symlink outside runtime control', () => {
  const fixture = makeRuntime();
  try {
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside);
    const realWorkflow = fixture.workflowDir;
    const moved = join(outside, WORKFLOW_ID);
    renameSync(realWorkflow, moved);
    symlinkSync(moved, realWorkflow, 'dir');
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
