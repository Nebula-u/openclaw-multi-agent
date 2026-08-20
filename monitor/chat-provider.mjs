import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';

function intentId() { return `INT-${randomUUID()}`; }

export function createChatProvider({ complete = null, projectRoot = process.cwd() } = {}) {
  const schema = JSON.parse(readFileSync(join(resolve(projectRoot), 'contracts', 'intent-draft.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  const validateDraft = (draft) => {
    if (!validate(draft)) throw Object.assign(new Error('chat provider returned an invalid intent draft'), { code: 'CHAT_INTENT_SCHEMA_INVALID', details: structuredClone(validate.errors ?? []) });
    return draft;
  };
  async function draft({ message, workflowId = null, context = null } = {}) {
    const text = String(message ?? '').trim();
    if (!text) throw Object.assign(new Error('message is required'), { code: 'CHAT_MESSAGE_REQUIRED' });
    if (complete) return validateDraft(await complete({ message: text, workflowId, context }));
    const lower = text.toLowerCase();
    let intent_type = 'QUESTION';
    let decision_id = null;
    let choice = null;
    if (/^(create|new)\b/u.test(lower) || lower.startsWith('创建') || lower.startsWith('新建')) intent_type = 'CREATE';
    else if (/^(change|revise)\b/u.test(lower) || lower.startsWith('修改') || lower.startsWith('变更')) intent_type = 'CHANGE';
    else if (/\b(approve|abort|retry|rework|批准|中止|重试|返工)\b/u.test(lower)) {
      intent_type = 'DECISION';
      choice = /abort|中止/u.test(lower) ? 'ABORT' : /retry|重试/u.test(lower) ? 'RETRY_SAME_AGENT' : /rework|返工/u.test(lower) ? 'REWORK' : 'APPROVE';
      decision_id = null;
    }
    return validateDraft({
      schema_version: 1,
      intent_id: intentId(),
      intent_type,
      summary: text,
      workflow_id: workflowId,
      decision_id,
      choice,
      route_plan: null,
      confidence: intent_type === 'QUESTION' ? 0.35 : 0.72,
      requires_confirmation: true,
    });
  }
  return { draft };
}
