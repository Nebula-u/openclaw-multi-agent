import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compileRoutePlan, loadStateGraphPolicy, verifyFrozenRoute } from '../scripts/stategraph/policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = loadStateGraphPolicy(ROOT);

test('Manager policy keeps the 200k context, 32k output and 12k prompt limits aligned', () => {
  assert.deepEqual(policy.manager, {
    context_window_tokens: 200000,
    max_output_tokens: 32000,
    soft_budget_percent: 60,
    prompt_max_chars: 12000,
    recent_events: 8,
    recent_error_reports: 4,
  });
  const sessionPolicy = JSON.parse(readFileSync(join(ROOT, 'config', 'manager-session-policy.json'), 'utf8'));
  assert.equal(sessionPolicy.model_context_window_tokens, policy.manager.context_window_tokens);
  assert.equal(sessionPolicy.max_output_tokens, policy.manager.max_output_tokens);
  assert.equal(sessionPolicy.soft_budget_percent, policy.manager.soft_budget_percent);
  assert.equal(sessionPolicy.soft_budget_tokens, 120000);
  assert.equal(sessionPolicy.prompt_max_chars, policy.manager.prompt_max_chars);
});

test('operational policy values are validated and exposed for Kernel/Harness wiring', () => {
  assert.equal(policy.lease_seconds, 120);
  assert.equal(policy.heartbeat_interval_seconds, 30);
  assert.deepEqual(policy.parallelism, { enabled: false, max_parallel: 1 });
});

test('lease policy fails closed when heartbeats could outlive the lease', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-policy-lease-'));
  try {
    mkdirSync(join(temp, 'config'));
    writeFileSync(join(temp, 'config', 'stategraph-policy.json'), JSON.stringify({
      manager: { context_window_tokens: 200000, max_output_tokens: 32000, soft_budget_percent: 60, prompt_max_chars: 12000 },
      lease_seconds: 60,
      heartbeat_interval_seconds: 30,
      parallelism: { enabled: false, max_parallel: 1 },
    }));
    assert.throws(() => loadStateGraphPolicy(temp), { code: 'POLICY_LEASE_TOO_SHORT' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('stategraph policy fails closed when Manager limits overflow the model context', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-policy-'));
  try {
    mkdirSync(join(temp, 'config'));
    writeFileSync(join(temp, 'config', 'stategraph-policy.json'), JSON.stringify({
      manager: {
        context_window_tokens: 200000,
        max_output_tokens: 100000,
        soft_budget_percent: 60,
        prompt_max_chars: 12000,
      },
    }));
    assert.throws(() => loadStateGraphPolicy(temp), { code: 'STATEGRAPH_POLICY_BUDGET_OVERFLOW' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function skipped(...included) {
  const all = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'TEST', 'RELEASE'];
  return all.filter((kind) => !included.includes(kind)).map((kind) => ({ kind, reason: `${kind} is outside this request` }));
}

test('code compiles Manager proposal into fixed Agent mappings and one immutable approval plan', () => {
  const value = {
    schema_version: 1,
    workflow_id: 'WF-small-code',
    request_class: 'SMALL_CODE',
    display_title: '修复局部逻辑',
    summary: '修复一个局部逻辑并回归测试',
    risk_flags: [],
    steps: [
      { step_id: 'requirements', kind: 'REQUIREMENTS', title: '收敛验收条件', rationale: '明确改动边界', human_approval_after: false, approval_reason: null },
      { step_id: 'development', kind: 'DEVELOPMENT', title: '局部修复', rationale: '实现需求', human_approval_after: false, approval_reason: null },
      { step_id: 'test', kind: 'TEST', title: '回归测试', rationale: '验证修复', human_approval_after: false, approval_reason: null },
    ],
    skipped_stages: skipped('REQUIREMENTS', 'DEVELOPMENT', 'TEST'),
  };
  const plan = compileRoutePlan(ROOT, value, policy);
  assert.deepEqual(plan.steps.map((item) => item.agent_id), ['requirement-agent', 'developer-agent', 'test-agent']);
  assert.deepEqual(plan.approval_plan.map((item) => item.kind), ['ROUTE_PLAN_CONFIRMATION']);
  const frozen = { ...plan, status: 'FROZEN', frozen_at: new Date().toISOString(), frozen_by: 'human:operator' };
  assert.equal(verifyFrozenRoute(frozen), true);
  assert.equal(verifyFrozenRoute({ ...frozen, summary: 'Agent attempted to change the route' }), false);
});

test('TEST_ONLY route does not require architecture or development', () => {
  const plan = compileRoutePlan(ROOT, {
    schema_version: 1,
    workflow_id: 'WF-test-only',
    request_class: 'TEST_ONLY',
    display_title: '运行现有测试',
    summary: '只执行现有测试',
    risk_flags: [],
    steps: [{ step_id: 'test', kind: 'TEST', title: '执行测试', rationale: '用户只要求测试', human_approval_after: false, approval_reason: null }],
    skipped_stages: skipped('TEST'),
  }, policy);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].agent_id, 'test-agent');
});

test('architecture threshold and elevated-risk approval are code-enforced', () => {
  const base = {
    schema_version: 1,
    workflow_id: 'WF-risk',
    request_class: 'FEATURE',
    display_title: '修改安全边界',
    summary: '修改安全边界',
    risk_flags: ['security_boundary'],
    steps: [
      { step_id: 'requirements', kind: 'REQUIREMENTS', title: '需求', rationale: '范围', human_approval_after: false, approval_reason: null },
      { step_id: 'development', kind: 'DEVELOPMENT', title: '开发', rationale: '实现', human_approval_after: false, approval_reason: null },
      { step_id: 'test', kind: 'TEST', title: '测试', rationale: '验证', human_approval_after: false, approval_reason: null },
    ],
    skipped_stages: skipped('REQUIREMENTS', 'DEVELOPMENT', 'TEST'),
  };
  assert.throws(() => compileRoutePlan(ROOT, base, policy), { code: 'ROUTE_PLAN_ARCHITECTURE_REQUIRED' });
  const withArchitecture = {
    ...base,
    steps: [base.steps[0], { step_id: 'architecture', kind: 'ARCHITECTURE', title: '架构', rationale: '安全边界变化', human_approval_after: true, approval_reason: '确认安全边界方案' }, ...base.steps.slice(1)],
    skipped_stages: skipped('REQUIREMENTS', 'ARCHITECTURE', 'DEVELOPMENT', 'TEST'),
  };
  const plan = compileRoutePlan(ROOT, withArchitecture, policy);
  assert.deepEqual(plan.approval_plan.map((item) => item.node_id), ['route-plan-confirmation', 'approval-after-architecture']);
});

test('parallel route hints are limited to read-only lifecycle stages', () => {
  const value = {
    schema_version: 1,
    workflow_id: 'WF-parallel-route',
    request_class: 'TEST_ONLY',
    display_title: '并行测试',
    summary: '并行执行只读测试步骤',
    risk_flags: [],
    steps: [{
      step_id: 'test',
      kind: 'TEST',
      title: '测试',
      rationale: '拆分只读测试任务',
      human_approval_after: false,
      approval_reason: null,
      split_hint: { max_parallel: 2, partition_by: 'FILE_GROUP' },
    }],
    skipped_stages: skipped('TEST'),
  };
  assert.doesNotThrow(() => compileRoutePlan(ROOT, value));
  const development = { ...value, steps: [{ ...value.steps[0], kind: 'DEVELOPMENT' }] };
  assert.throws(() => compileRoutePlan(ROOT, development), (error) => error.code === 'ROUTE_PLAN_PARALLEL_KIND_FORBIDDEN');
});
