import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { compileRoutePlan, loadStateGraphPolicy, verifyFrozenRoute } from '../scripts/stategraph/policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const policy = loadStateGraphPolicy(ROOT);

function skipped(...included) {
  const all = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'TEST', 'RELEASE'];
  return all.filter((kind) => !included.includes(kind)).map((kind) => ({ kind, reason: `${kind} is outside this request` }));
}

test('code compiles Manager proposal into fixed Agent mappings and one immutable approval plan', () => {
  const value = {
    schema_version: 1,
    workflow_id: 'WF-small-code',
    request_class: 'SMALL_CODE',
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
