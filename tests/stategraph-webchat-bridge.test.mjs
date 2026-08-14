import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebchatWorkflowBridge } from '../scripts/stategraph/webchat-bridge.mjs';

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
  const approved = await bridge.handle({ text: '确认', sessionKey: 'agent:manager-agent:main', senderId: 'owner' });
  assert.match(approved.reply, /人工确认已写入 checkpoint/u);
  assert.equal(calls.filter(([kind]) => kind === 'bootstrap').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'approve').length, 1);
  assert.match(calls.find(([kind]) => kind === 'approve')[2].decided_by, /^human:/u);
});
