import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebchatWorkflowBridge, isApprovalMessage } from '../scripts/stategraph/webchat-bridge.mjs';
import plugin, { isInteractiveManagerInbound, isInteractiveManagerRun } from '../extensions/stategraph-webchat/index.js';

test('Gateway hook accepts interactive manager sessions and rejects StateGraph child sessions', () => {
  const options = { managerAgentId: 'manager-agent', sessionPrefixes: ['agent:manager-agent:tui-', 'agent:manager-agent:dashboard:', 'agent:manager-agent:main'] };
  assert.equal(isInteractiveManagerInbound({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:tui-123' }, { senderIsOwner: true }, options), true);
  assert.equal(isInteractiveManagerInbound({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:dashboard:123' }, { senderIsOwner: true }, options), true);
  assert.equal(isInteractiveManagerInbound({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:explicit:child' }, { senderIsOwner: true }, options), false);
  assert.equal(isInteractiveManagerInbound({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:tui-123' }, { senderIsOwner: false }, options), false);
  assert.equal(isInteractiveManagerRun({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:tui-123' }, { senderIsOwner: false, channelId: 'webchat' }, options), true);
  assert.equal(isInteractiveManagerRun({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:dashboard:123' }, { senderIsOwner: true }, options), true);
  assert.equal(isInteractiveManagerRun({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:explicit:child' }, { senderIsOwner: true }, options), false);
  assert.equal(isInteractiveManagerRun({ agentId: 'manager-agent', sessionKey: 'agent:manager-agent:main' }, { senderIsOwner: false, channelId: 'telegram' }, options), false);
  assert.equal(plugin.id, 'stategraph-webchat');
});

test('natural Chinese route confirmation is accepted but negated wording is not', () => {
  assert.equal(isApprovalMessage('这条路线可以，就这么走'), true);
  assert.equal(isApprovalMessage('/workflow approve'), true);
  assert.equal(isApprovalMessage('我不同意这条路线'), false);
  assert.equal(isApprovalMessage('先别确认'), false);
});

test('WebChat bridge creates workflow and records route approval before dispatch', async () => {
  const states = [];
  const calls = [];
  const runtime = {
    async list() { return states; },
    async bootstrap({ workflowId, request }) { calls.push(['bootstrap', workflowId]); states.push({ workflowId, request, condition: 'ACTIVE', phase: 'MANAGER_ANALYSIS', stopReason: 'MANAGER_TASK_READY', updatedAt: '2026-08-14T00:00:00Z' }); },
    async run(id) { calls.push(['run', id]); const state = states[0]; state.condition = 'WAITING_HUMAN'; state.phase = 'HUMAN_APPROVAL'; state.stopReason = 'ROUTE_PLAN_APPROVAL_REQUIRED'; state.pendingApproval = { decision_id: 'DEC-route', title: '确认路线', summary: '聊天室路线', options: [{ id: 'APPROVE' }], steps: [{ title: '需求分析', agent_id: 'requirement-agent', human_approval_after: false }] }; return state; },
    async state() { return states[0]; },
    async approve(id, command) { calls.push(['approve', id, command]); states[0].condition = 'ACTIVE'; states[0].pendingApproval = null; },
  };
  const bridge = createWebchatWorkflowBridge({ runtime, projectPath: 'D:\\target' });
  const created = await bridge.handle({ text: '实现聊天室', sessionKey: 'agent:manager-agent:main', senderId: 'owner' });
  assert.match(created.reply, /requirement-agent/u);
  const approved = await bridge.handle({ text: '这条路线可以，就这么走', sessionKey: 'agent:manager-agent:main', senderId: 'owner' });
  assert.match(approved.reply, /人工确认已写入 checkpoint/u);
  assert.equal(calls.filter(([kind]) => kind === 'bootstrap').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'approve').length, 1);
  assert.match(calls.find(([kind]) => kind === 'approve')[2].decided_by, /^human:/u);
});

test('natural confirmation retries the same Agent after error escalation', async () => {
  const state = {
    workflowId: 'WF-error', request: { source_session_key: 'agent:manager-agent:main' },
    condition: 'WAITING_HUMAN', updatedAt: '2026-08-17T00:00:00Z',
    pendingApproval: { decision_id: 'DEC-error', kind: 'ERROR_ESCALATION', title: '错误升级', question: '是否重试？', options: [{ id: 'RETRY_SAME_AGENT' }] },
  };
  let command;
  const runtime = {
    async list() { return [state]; }, async approve(_id, value) { command = value; state.condition = 'ACTIVE'; state.pendingApproval = null; },
    async run() { return { ...state, condition: 'ACTIVE', stop_reason: 'TASK_DISPATCHED' }; }, async state() { return state; },
  };
  const bridge = createWebchatWorkflowBridge({ runtime, projectPath: 'D:\\target' });
  await bridge.handle({ text: '确认重试', sessionKey: 'agent:manager-agent:main', senderId: 'owner' });
  assert.equal(command.choice, 'RETRY_SAME_AGENT');
  assert.equal(command.decision_id, 'DEC-error');
});
