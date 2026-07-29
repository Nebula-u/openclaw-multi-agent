import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    '--skip-git',
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

test('check-workflow rejects PASS while an approval is pending', () => {
  const decisionId = 'DEC-00000000-0000-0000-0000-000000000001';
  const fixture = makeRuntime({
    status: 'WAITING_HUMAN',
    phase: 'INTAKE',
    pendingDecisionIds: [decisionId],
  });
  try {
    writeJson(join(fixture.workflowDir, 'decisions', `${decisionId}.request.json`), {
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
