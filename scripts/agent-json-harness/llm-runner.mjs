import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT, validateLlmResponse } from './runtime-guard-client.mjs';
import { buildEmptyLlmRetryPrompt, buildLlmCasePrompt, buildLlmRetryPrompt } from './llm-scenarios.mjs';

const MAX_EMPTY_RESPONSE_RETRIES = 3;

function sessionKey({ scenario, testCase, runId }) {
  return `agent:${scenario.agentId}:llm-json-${runId}-${scenario.name}-${testCase.id}`;
}

async function attempt({ client, scenario, testCase, runId, prompt, attemptNumber, timeoutMs }) {
  const key = sessionKey({ scenario, testCase, runId });
  try {
    const response = await client.send({ agentId: scenario.agentId, sessionKey: key, prompt, expectedReplyCount: attemptNumber, timeoutMs });
    return { attempt: attemptNumber, prompt, response, validation: validateLlmResponse(response, scenario), error: null };
  } catch (error) {
    return {
      attempt: attemptNumber, prompt, response: null,
      validation: { ok: false, errors: [{ code: 'LLM_INVOCATION_ERROR', path: '$', message: error.message }] },
      error: error.message,
    };
  }
}

function isEmptyResponse(attemptResult) {
  return attemptResult.error === null
    && typeof attemptResult.response === 'string'
    && attemptResult.response.trim().length === 0;
}

async function retryEmptyResponses({ client, scenario, testCase, runId, timeoutMs, attempts, prompt, nextAttemptNumber }) {
  let currentPrompt = prompt;
  let attemptNumber = nextAttemptNumber;
  let retries = 0;
  let latest = attempts.at(-1);
  while (isEmptyResponse(latest) && retries < MAX_EMPTY_RESPONSE_RETRIES) {
    retries += 1;
    currentPrompt = buildEmptyLlmRetryPrompt(retries);
    latest = await attempt({ client, scenario, testCase, runId, prompt: currentPrompt, attemptNumber, timeoutMs });
    attempts.push(latest);
    attemptNumber += 1;
  }
  return { latest, retries, nextAttemptNumber: attemptNumber };
}

export async function runLlmCase({ client, scenario, testCase, runId, timeoutMs = 600000 }) {
  const schemaText = readFileSync(join(PROJECT_ROOT, 'contracts', scenario.schemaFile), 'utf8').trim();
  const firstPrompt = buildLlmCasePrompt(scenario, testCase, schemaText);
  const first = await attempt({ client, scenario, testCase, runId, prompt: firstPrompt, attemptNumber: 1, timeoutMs });
  const attempts = [first];
  const initial = await retryEmptyResponses({
    client, scenario, testCase, runId, timeoutMs, attempts, prompt: firstPrompt, nextAttemptNumber: 2,
  });
  if (isEmptyResponse(initial.latest)) {
    return {
      classification: 'EMPTY_RETRY_FAILED', scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }),
      attempts, empty_retries: initial.retries,
    };
  }
  if (initial.latest.validation.ok) {
    return {
      classification: initial.retries === 0 ? 'PASSED_FIRST' : 'EMPTY_RETRY_SUCCEEDED',
      scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }), attempts, empty_retries: initial.retries,
    };
  }

  const retryPrompt = buildLlmRetryPrompt(initial.latest.validation.errors ?? []);
  const schemaAttempt = await attempt({
    client, scenario, testCase, runId, prompt: retryPrompt, attemptNumber: initial.nextAttemptNumber, timeoutMs,
  });
  attempts.push(schemaAttempt);
  const schemaResult = await retryEmptyResponses({
    client, scenario, testCase, runId, timeoutMs, attempts, prompt: retryPrompt, nextAttemptNumber: initial.nextAttemptNumber + 1,
  });
  return {
    classification: schemaResult.latest.validation.ok ? 'SCHEMA_RETRY_SUCCEEDED' : (isEmptyResponse(schemaResult.latest) ? 'EMPTY_RETRY_FAILED' : 'RETRY_FAILED'),
    scenario, testCase, sessionKey: sessionKey({ scenario, testCase, runId }), attempts, empty_retries: initial.retries + schemaResult.retries,
  };
}
