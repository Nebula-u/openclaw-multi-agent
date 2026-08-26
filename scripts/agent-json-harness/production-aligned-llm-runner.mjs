import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT, validateLlmResponse } from './runtime-guard-client.mjs';
import { buildProductionAlignedLlmCasePrompt } from './production-aligned-llm-scenarios.mjs';
import { MAX_REPAIR_RETRIES, buildJsonRepairPrompt, classifyLlmFailure } from './json-repair-prompts.mjs';

function sessionKey({ scenario, testCase, runId }) {
  return `agent:${scenario.agentId}:llm-json-production-aligned-${runId}-${scenario.name}-${testCase.id}`;
}

async function attempt({ client, scenario, testCase, runId, prompt, attemptNumber, timeoutMs }) {
  const key = sessionKey({ scenario, testCase, runId });
  try {
    const response = await client.send({ agentId: scenario.agentId, sessionKey: key, prompt, expectedReplyCount: attemptNumber, timeoutMs });
    return { attempt: attemptNumber, prompt, response, validation: validateLlmResponse(response, scenario), error: null };
  } catch (error) {
    return { attempt: attemptNumber, prompt, response: null, validation: { ok: false, errors: [{ code: 'LLM_INVOCATION_ERROR', path: '$', message: error.message }] }, error: error.message };
  }
}

function classificationFor(result) {
  if (result.error) return 'LLM_INVOCATION_ERROR';
  return classifyLlmFailure({ response: result.response, validation: result.validation, ingestionError: result.validation.ingestion?.error });
}

export async function runProductionAlignedLlmCase({ client, scenario, testCase, runId, timeoutMs = 600000 }) {
  const schemaText = readFileSync(join(PROJECT_ROOT, 'contracts', scenario.schemaFile), 'utf8').trim();
  let prompt = buildProductionAlignedLlmCasePrompt(scenario, testCase, schemaText);
  const attempts = [];
  let finalClassification = null;
  for (let attemptNumber = 1; attemptNumber <= MAX_REPAIR_RETRIES + 1; attemptNumber += 1) {
    const result = await attempt({ client, scenario, testCase, runId, prompt, attemptNumber, timeoutMs });
    attempts.push(result);
    if (result.error) return { classification: 'TRANSPORT_FAILURE', repair_classification: 'LLM_INVOCATION_ERROR', scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }), attempts, repair_retries: 0 };
    if (result.validation.ok) return { classification: attemptNumber === 1 ? 'PASSED_FIRST' : 'REPAIR_RETRY_SUCCEEDED', repair_classification: finalClassification, scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }), attempts, repair_retries: attemptNumber - 1 };
    finalClassification = classificationFor(result);
    if (attemptNumber > MAX_REPAIR_RETRIES) break;
    prompt = buildJsonRepairPrompt({ classification: finalClassification, errors: result.validation.errors ?? [], retryNumber: attemptNumber });
  }
  return { classification: finalClassification === 'EMPTY_RESPONSE' ? 'EMPTY_RETRY_FAILED' : 'RETRY_FAILED', repair_classification: finalClassification, scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }), attempts, repair_retries: MAX_REPAIR_RETRIES };
}
