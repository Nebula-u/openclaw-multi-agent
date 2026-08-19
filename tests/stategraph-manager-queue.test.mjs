import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createManagerRequestProcessor } from '../scripts/stategraph/manager-request-queue.mjs';
import { bindEphemeralSchema, consumeEphemeralSchema, releaseEphemeralSchema } from '../scripts/stategraph/ephemeral-schema.mjs';

function route(workflowId) {
  return { schema_version: 1, workflow_id: workflowId, request_class: 'ANALYSIS_ONLY', summary: '分析需求', display_title: '需求分析', risk_flags: [],
    steps: [{ step_id: 'requirements', kind: 'REQUIREMENTS', title: '分析需求', rationale: '用户要求分析', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'TEST', 'RELEASE'].map((kind) => ({ kind, reason: '分析任务不需要该阶段' })) };
}

test('Manager request queue accepts only explicit user-authorized workflow creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-request-'));
  try {
    const workspace = join(root, 'manager'); const project = join(root, 'target'); mkdirSync(project, { recursive: true });
    const calls = [];
    let runCalls = 0;
    const state = { workflowId: 'WF-cli', revision: 1, workflowTitle: '需求分析', condition: 'ACTIVE', phase: 'ROUTING', statusReason: 'confirmed', routePlan: { route_hash: 'a'.repeat(64) }, currentStepIndex: 0, steps: [], tasks: [
      { agent_id: 'requirement-agent', result: { result_status: 'COMPLETED', summary_for_user: '需求已确认', summary_for_manager: '可进入下一阶段' } },
      { agent_id: 'developer-agent', status: 'READY' },
    ], updatedAt: new Date().toISOString() };
    const runtime = { async bootstrapConfirmed(value) { calls.push(value); }, async state() { return state; }, async run() { runCalls += 1; return state; }, async list() { return [state]; } };
    const processor = createManagerRequestProcessor({ runtime, projectRoot: root, managerWorkspace: workspace, targetProjectRoot: project });
    writeFileSync(join(processor.requests, 'create.json'), JSON.stringify({ schema_version: 1, request_id: 'REQ-cli', request_type: 'CREATE', workflow_id: 'WF-cli', submitted_by: 'manager-agent', submitted_at: new Date().toISOString(), project_path_abs: project, original_request: '分析需求', user_authorized: { confirmed: true, actor: 'human:cli-owner', message: '确认' }, route_plan: route('WF-cli') }));
    const [receipt] = await processor.scan();
    assert.equal(receipt.status, 'ACCEPTED');
    assert.equal(calls.length, 1);
    assert.equal(runCalls, 0, 'creation scan must publish confirmed READY progress before dispatch');
    assert.equal(calls[0].request.user_confirmation.actor, 'human:cli-owner');
    const managerStatus = JSON.parse(readFileSync(join(processor.status, 'WF-cli.json'), 'utf8'));
    assert.equal(managerStatus.condition, 'ACTIVE');
    assert.equal(managerStatus.latest_agent_result.summary_for_user, '需求已确认');
    assert.equal(managerStatus.manager_notification, null);
    await processor.scan();
    assert.equal(runCalls, 1, 'the next scan may advance the already-published workflow once');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('JSON schema binding is temporary prompt context and is released after one agent process', () => {
  const root = mkdtempSync(join(tmpdir(), 'ephemeral-schema-'));
  try {
    mkdirSync(join(root, 'contracts'), { recursive: true });
    writeFileSync(join(root, 'contracts', 'result.schema.json'), JSON.stringify({ type: 'object', required: ['result_status'] }));
    const path = bindEphemeralSchema({ projectRoot: root, task: { kind: 'TEST', session_id: 'session-1', agent_id: 'test-agent', task_id: 'TASK-1', run_id: 'RUN-1' }, cycle: 0 });
    const context = consumeEphemeralSchema({ projectRoot: root, sessionId: 'session-1', agentId: 'test-agent' });
    assert.match(context, /仅注入本次模型调用/u);
    assert.match(context, /result_status/u);
    assert.equal(consumeEphemeralSchema({ projectRoot: root, sessionId: 'session-1', agentId: 'developer-agent' }), null);
    releaseEphemeralSchema(path);
    assert.equal(consumeEphemeralSchema({ projectRoot: root, sessionId: 'session-1', agentId: 'test-agent' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Manager status explicitly notifies the Manager when any human approval is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-approval-notice-'));
  try {
    const workspace = join(root, 'manager'); const project = join(root, 'target'); mkdirSync(project, { recursive: true });
    const state = {
      workflowId: 'WF-approval', revision: 7, workflowTitle: '审批测试', condition: 'WAITING_HUMAN', phase: 'HUMAN_APPROVAL',
      statusReason: '需要人工决定', routePlan: { route_hash: 'b'.repeat(64) }, currentStepIndex: 0, steps: [], tasks: [], updatedAt: new Date().toISOString(),
      pendingApproval: { decision_id: 'DEC-approval-1', kind: 'ERROR_ESCALATION', title: 'Agent 连续失败', question: '是否重试？', options: [{ id: 'RETRY_SAME_AGENT', label: '重试' }, { id: 'ABORT', label: '终止' }] },
    };
    const runtime = { async state() { return state; }, async list() { return [state]; } };
    const processor = createManagerRequestProcessor({ runtime, projectRoot: root, managerWorkspace: workspace, targetProjectRoot: project });
    await processor.scan();
    const status = JSON.parse(readFileSync(join(processor.status, 'WF-approval.json'), 'utf8'));
    assert.equal(status.pending_user_decision.decision_id, 'DEC-approval-1');
    assert.equal(status.manager_notification.type, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(status.manager_notification.action, 'EXPLAIN_TO_USER_AND_WAIT_FOR_CHOICE');
    assert.deepEqual(status.manager_notification.options, state.pendingApproval.options);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Manager DECISION requests use the manager envelope, not approval-response fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-decision-envelope-'));
  try {
    const workspace = join(root, 'manager'); const project = join(root, 'target'); mkdirSync(project, { recursive: true });
    const calls = [];
    const state = { workflowId: 'WF-decision', revision: 3, workflowTitle: '审批测试', condition: 'WAITING_HUMAN', phase: 'HUMAN_APPROVAL', routePlan: { route_hash: 'c'.repeat(64) }, currentStepIndex: 0, steps: [], tasks: [], updatedAt: new Date().toISOString(), pendingApproval: { decision_id: 'DEC-decision-1', kind: 'ERROR_ESCALATION', title: '失败升级', question: '是否重试？', options: [{ id: 'RETRY_SAME_AGENT', label: '重试' }, { id: 'ABORT', label: '终止' }] } };
    const runtime = { async state() { return state; }, async list() { return [state]; }, async approve(workflowId, command) { calls.push({ workflowId, command }); } };
    const processor = createManagerRequestProcessor({ runtime, projectRoot: root, managerWorkspace: workspace, targetProjectRoot: project });
    writeFileSync(join(processor.requests, 'decision.json'), JSON.stringify({ schema_version: 1, request_id: 'REQ-decision-1', request_type: 'DECISION', workflow_id: 'WF-decision', submitted_by: 'manager-agent', decision_id: 'DEC-decision-1', choice: 'RETRY_SAME_AGENT', notes: '用户选择重试', user_authorized: { confirmed: true, actor: 'human:cli-owner', message: '同一 Agent 重试' } }));
    const [receipt] = await processor.scan();
    assert.equal(receipt.status, 'ACCEPTED');
    assert.equal(calls[0].command.choice, 'RETRY_SAME_AGENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
