import { createHash, randomUUID } from 'node:crypto';

const APPROVE_COMMAND = /^\/workflow\s+approve(?:\s|$)/iu;
const APPROVE_WORDING = /(?:确认|同意|批准|可以(?:，|,)?\s*就这么走|就这么走|按这个(?:方案|路线)(?:走|执行)|开始执行)/u;
const NEGATED_APPROVAL = /(?:不确认|不同意|不批准|不可以|不能|不要|先别|暂不|取消)/u;

export function isApprovalMessage(text) {
  const value = String(text ?? '').trim();
  return APPROVE_COMMAND.test(value) || (!NEGATED_APPROVAL.test(value) && APPROVE_WORDING.test(value));
}

function approvalChoice(pending) {
  const optionIds = new Set((pending?.options ?? []).map((option) => option.id));
  if (optionIds.has('APPROVE')) return 'APPROVE';
  if (pending?.kind === 'ERROR_ESCALATION' && optionIds.has('RETRY_SAME_AGENT')) return 'RETRY_SAME_AGENT';
  return null;
}

function workflowId() { return `WF-WEB-${randomUUID().replaceAll('-', '')}`; }
function actor(value) { return `human:${createHash('sha256').update(String(value || 'webchat-owner')).digest('hex').slice(0, 16)}`; }

export function formatWorkflowReply(state, prefix = '') {
  const pending = state?.pendingApproval;
  if (pending) {
    const steps = (pending.steps ?? []).map((step, index) => `${index + 1}. ${step.title}（${step.agent_id}）${step.human_approval_after ? '，完成后人工确认' : ''}`).join('\n');
    const instruction = pending.kind === 'ROUTE_PLAN_CONFIRMATION'
      ? '回复“确认”或“/workflow approve”后，StateGraph 将冻结当前路线并派发下一 Agent。'
      : pending.kind === 'ERROR_ESCALATION'
        ? '回复“确认重试”后，StateGraph 将开启同一 Agent 的新重试批次。'
        : '回复“确认”或“/workflow approve”后，StateGraph 将把本次人工决定写入 checkpoint 并继续执行。';
    return `${prefix}workflow ${state.workflowId} 已进入人工审批。\n\n${pending.title}\n${pending.summary ?? pending.question}\n${steps ? `\n${steps}\n` : ''}\n${instruction}`;
  }
  if (state?.condition === 'TERMINAL') return `${prefix}workflow ${state.workflowId} 已结束：${state.outcome ?? state.stopReason}`;
  return `${prefix}workflow ${state?.workflowId ?? 'UNKNOWN'} 已创建并由 StateGraph 执行，当前阶段：${state?.phase ?? 'INITIALIZING'}，状态：${state?.stopReason ?? state?.condition ?? 'ACTIVE'}。发送“/workflow status”可读取最新 checkpoint。`;
}

export function createWebchatWorkflowBridge({ runtime, projectPath, maxTurns = 8 } = {}) {
  let scanning = false;
  async function advance(id) {
    let result = null;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      result = await runtime.run(id);
      if (['WAITING_HUMAN', 'TERMINAL', 'HOLD'].includes(result.condition) || ['TASK_RUNNING', 'TASK_DISPATCHED', 'JSON_REPAIR_READY'].includes(result.stop_reason)) break;
    }
    return runtime.state(id);
  }
  async function related(sessionKey) {
    return (await runtime.list()).filter((state) => state.request?.source_session_key === sessionKey)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }
  async function handle({ text, sessionKey, senderId }) {
    const current = (await related(sessionKey))[0] ?? null;
    if (current?.condition === 'WAITING_HUMAN') {
      if (!isApprovalMessage(text)) return { handled: true, reply: formatWorkflowReply(current) };
      const choice = approvalChoice(current.pendingApproval);
      if (!choice) return { handled: true, reply: formatWorkflowReply(current, '当前审批不支持直接确认。\n') };
      await runtime.approve(current.workflowId, { decision_id: current.pendingApproval.decision_id, choice, decided_by: actor(senderId), notes: text.trim(), decided_at: new Date().toISOString() });
      const state = await advance(current.workflowId);
      return { handled: true, reply: formatWorkflowReply(state, '人工确认已写入 checkpoint。\n') };
    }
    if (current && !['TERMINAL', 'HOLD'].includes(current.condition)) {
      const state = await advance(current.workflowId);
      return { handled: true, reply: formatWorkflowReply(state) };
    }
    const id = workflowId();
    await runtime.bootstrap({ workflowId: id, request: { text: text.trim(), project_path_abs: projectPath, source: 'OPENCLAW_WEBCHAT', source_session_key: sessionKey, submitted_by: actor(senderId), submitted_at: new Date().toISOString() } });
    const state = await advance(id);
    return { handled: true, reply: formatWorkflowReply(state) };
  }
  async function scan() {
    if (scanning) return; scanning = true;
    try { for (const state of await runtime.list()) if (state.condition === 'ACTIVE') await advance(state.workflowId); }
    finally { scanning = false; }
  }
  return { handle, scan };
}
