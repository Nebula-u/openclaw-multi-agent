#!/usr/bin/env node
// Sends exactly ten lightweight prompts to one registered Agent. It never calls a model API directly.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from '../agent-json-harness/gateway-llm-client.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady, validateLlmResponse } from '../agent-json-harness/runtime-guard-client.mjs';
import { classifyLlmFailure } from '../agent-json-harness/json-repair-prompts.mjs';
import { validateAgentTimeoutMs } from '../agent-json-harness/timeout-policy.mjs';
import { getContractScenario } from './contract-scenarios.mjs';

const CALL_COUNT = 10;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runId() {
  return `contract-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function promptFor({ schemaText, jsonl, ordinal }) {
  const format = jsonl ? 'JSONL（每个非空行必须是一个完整 JSON 对象）' : '一个完整 JSON 对象';
  return [
    '这是轻量 JSON 契约通信测试。不要调用工具，不要读写文件，不要做任务分析。',
    `请仅返回 ${format}；不得使用 Markdown、解释、前后缀或多个候选。`,
    'JSON 形态示例（只说明格式，不能照抄字段和值）：{"field":"value"}。',
    `本次是固定十次测试的第 ${ordinal}/${CALL_COUNT} 次。仅生成 Schema 可支持的保守测试数据，不得虚构外部事实。`,
    '唯一有效的 JSON Schema 如下：',
    '```json', schemaText, '```',
  ].join('\n');
}

function failureRecord({ ordinal, response, validation }) {
  const ingestionError = validation.ingestion?.error;
  return {
    ordinal,
    classification: validation.errors?.some((error) => error.code === 'AGENT_COMMUNICATION_ERROR')
      ? 'AGENT_COMMUNICATION_ERROR'
      : response === null ? 'AGENT_NO_TEXT_RESPONSE' : classifyLlmFailure({ response, validation, ingestionError }),
    response_sha256: validation.ingestion?.raw_sha256 ?? null,
    cleaned_sha256: validation.ingestion?.cleaned_sha256 ?? null,
    transformations: validation.ingestion?.transformations ?? [],
    ingestion_error: ingestionError ?? null,
    validator_errors: validation.errors ?? [],
    response,
  };
}

export async function runContractTest({ schemaFile, outputRoot = join(PROJECT_ROOT, 'artifacts', 'agent-llm-contract-tests'), timeoutMs = 120000 }) {
  timeoutMs = validateAgentTimeoutMs(timeoutMs);
  const scenario = getContractScenario(schemaFile);
  const schemaText = await import('node:fs').then(({ readFileSync }) => readFileSync(join(PROJECT_ROOT, 'contracts', schemaFile), 'utf8').trim());
  assertRuntimeGuardReady();
  const root = resolve(outputRoot, runId(), schemaFile.replace(/\.schema\.json$/u, ''));
  const client = await connectGatewayLlmClient();
  const results = [];
  const errorBundle = [];
  try {
    for (let ordinal = 1; ordinal <= CALL_COUNT; ordinal += 1) {
      const sessionKey = `agent:${scenario.agentId}:contract-test-${Date.now()}-${ordinal}`;
      let response = null;
      let validation;
      try {
        response = await client.send({ agentId: scenario.agentId, sessionKey, prompt: promptFor({ schemaText, jsonl: scenario.jsonl, ordinal }), timeoutMs });
        validation = validateLlmResponse(response, scenario);
      } catch (error) {
        validation = { ok: false, errors: [{ code: 'AGENT_COMMUNICATION_ERROR', path: '$', message: error.message }], ingestion: null };
      }
      const item = { ordinal, session_key: sessionKey, ok: validation.ok, validation };
      results.push(item);
      if (!validation.ok) {
        const failure = failureRecord({ ordinal, response, validation });
        errorBundle.push(failure);
        writeJson(join(root, 'failures', `call-${ordinal}.json`), failure);
      }
    }
  } finally {
    client.close();
  }
  const failures = results.filter((item) => !item.ok);
  writeJson(join(root, 'errors.json'), errorBundle);
  writeJson(join(root, 'summary.json'), {
    schema_file: schemaFile, agent_id: scenario.agentId, jsonl: scenario.jsonl,
    calls_planned: CALL_COUNT, calls_executed: results.length, passed: results.length - failures.length,
    failed: failures.length, failures_file: 'errors.json',
  });
  process.stdout.write(`${root}\n`);
  return { root, results };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--schema') result.schemaFile = argv[++index];
    else if (argv[index] === '--output-root') result.outputRoot = argv[++index];
    else if (argv[index] === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.schemaFile) throw new Error('Usage: node run-contract.mjs --schema <contracts file>');
  validateAgentTimeoutMs(result.timeoutMs ?? 120000, '--timeout-seconds');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  runContractTest(options).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
