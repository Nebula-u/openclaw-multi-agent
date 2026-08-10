#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from '../agent-json-harness/gateway-llm-client.mjs';
import { classifyLlmFailure } from '../agent-json-harness/json-repair-prompts.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady, validateLlmResponse } from '../agent-json-harness/runtime-guard-client.mjs';
import {
  JSON_SCHEMA_AGENT_SCENARIOS,
  PROMPTS_PER_SCENARIO,
  REPETITIONS_PER_PROMPT,
} from './json-schema-test-scenarios.mjs';

export const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-json-schema-matrix');
export const DEFAULT_TIMEOUT_MS = 600000;

function runId() {
  return `matrix-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeSegment(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error(`${label} must be one safe path segment: ${value}`);
  return value;
}

function classificationFor({ response, validation, error }) {
  if (error) return 'AGENT_COMMUNICATION_ERROR';
  if (response === null) return 'AGENT_NO_TEXT_RESPONSE';
  return classifyLlmFailure({
    response,
    validation,
    ingestionError: validation?.ingestion?.error,
  });
}

function createScenarioRow(scenario, repetitions) {
  return {
    name: scenario.name,
    schema_file: scenario.schemaFile,
    agent_id: scenario.agentId,
    jsonl: scenario.jsonl,
    prompts: scenario.prompts.map((prompt) => ({
      id: prompt.id,
      planned: repetitions,
      executed: 0,
      passed: 0,
      failed: 0,
      classifications: {},
    })),
    planned: scenario.prompts.length * repetitions,
    executed: 0,
    passed: 0,
    failed: 0,
  };
}

function createSummary({ requestedRunId, scenarios, repetitions, timeoutMs }) {
  return {
    generated_from: 'scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs',
    run_id: requestedRunId,
    run_status: 'RUNNING',
    started_at: new Date().toISOString(),
    timeout_ms: timeoutMs,
    prompts_per_scenario: PROMPTS_PER_SCENARIO,
    repetitions_per_prompt: repetitions,
    scenarios: scenarios.map((scenario) => createScenarioRow(scenario, repetitions)),
    totals: {
      planned: scenarios.reduce((total, scenario) => total + scenario.prompts.length * repetitions, 0),
      executed: 0,
      passed: 0,
      failed: 0,
    },
  };
}

function createManifest({ requestedRunId, scenarios, repetitions, timeoutMs }) {
  return {
    generated_from: 'scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs',
    run_id: requestedRunId,
    started_at: new Date().toISOString(),
    project_root_abs: PROJECT_ROOT,
    scenario_count: scenarios.length,
    prompts_per_scenario: PROMPTS_PER_SCENARIO,
    repetitions_per_prompt: repetitions,
    calls_planned: scenarios.reduce((total, scenario) => total + scenario.prompts.length * repetitions, 0),
    timeout_ms: timeoutMs,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      schema_file: scenario.schemaFile,
      schema_path: scenario.schemaPath,
      agent_id: scenario.agentId,
      jsonl: scenario.jsonl,
      prompts: scenario.prompts.map((prompt) => ({
        id: prompt.id,
        requirement: prompt.requirement,
        prompt_sha256: sha256(prompt.text),
      })),
    })),
  };
}

function writePrompts(path, scenarios) {
  writeJson(path, scenarios.map((scenario) => ({
    name: scenario.name,
    schema_file: scenario.schemaFile,
    agent_id: scenario.agentId,
    jsonl: scenario.jsonl,
    prompts: scenario.prompts.map((prompt) => ({
      id: prompt.id,
      topic: prompt.topic,
      owner: prompt.owner,
      requirement: prompt.requirement,
      language: prompt.language,
      text: prompt.text,
      prompt_sha256: sha256(prompt.text),
    })),
  })));
}

function renderReport(summary) {
  const lines = [
    '# Agent JSON Schema 全量矩阵测试报告',
    '',
    `- 运行 ID：\`${summary.run_id}\``,
    `- 运行状态：${summary.run_status}`,
    `- 场景数：${summary.scenarios.length}`,
    `- 每场景 prompt 数：${summary.prompts_per_scenario}`,
    `- 每个 prompt 重复数：${summary.repetitions_per_prompt}`,
    `- 计划调用数：${summary.totals.planned}`,
    `- 已执行调用数：${summary.totals.executed}`,
    `- 校验通过：${summary.totals.passed}`,
    `- 校验失败：${summary.totals.failed}`,
  ];
  if (summary.abort_reason) lines.push(`- 中止原因：${summary.abort_reason}`);
  lines.push('', '| 场景 | Prompt | 计划 | 已执行 | 通过 | 失败 | 分类 |', '| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    for (const prompt of scenario.prompts) {
      const classifications = Object.entries(prompt.classifications).map(([name, count]) => `${name}:${count}`).join(', ') || '-';
      lines.push(`| ${scenario.name} | ${prompt.id} | ${prompt.planned} | ${prompt.executed} | ${prompt.passed} | ${prompt.failed} | ${classifications} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeSummary(runRoot, summary) {
  writeJson(join(runRoot, 'summary.json'), summary);
  writeFileSync(join(runRoot, 'report.md'), renderReport(summary), 'utf8');
}

function validateOptions({ scenarios, repetitions, timeoutMs }) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('至少需要一个 JSON Schema 测试场景。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('超时时间必须为正数。');
  for (const scenario of scenarios) {
    if (!scenario.name || !scenario.schemaFile || !scenario.agentId || !Array.isArray(scenario.prompts) || scenario.prompts.length === 0) {
      throw new Error(`测试场景结构不完整：${JSON.stringify(scenario)}`);
    }
  }
}

export async function runJsonSchemaMatrix({
  scenarios = JSON_SCHEMA_AGENT_SCENARIOS,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  runId: requestedRunId = runId(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  repetitions = REPETITIONS_PER_PROMPT,
  createClient = connectGatewayLlmClient,
  validateResponse = validateLlmResponse,
  onProgress = () => {},
} = {}) {
  validateOptions({ scenarios, repetitions, timeoutMs });
  const safeRunId = safeSegment(requestedRunId, 'run-id');
  const runRoot = resolve(outputRoot, safeRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });

  const summary = createSummary({ requestedRunId: safeRunId, scenarios, repetitions, timeoutMs });
  const summaryPath = join(runRoot, 'summary.json');
  const resultsPath = join(runRoot, 'results.jsonl');
  writeFileSync(resultsPath, '', 'utf8');
  writeJson(join(runRoot, 'manifest.json'), createManifest({ requestedRunId: safeRunId, scenarios, repetitions, timeoutMs }));
  writePrompts(join(runRoot, 'prompts.json'), scenarios);
  writeSummary(runRoot, summary);

  let client = null;
  let abortError = null;
  try {
    assertRuntimeGuardReady();
    client = await createClient();
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const scenarioRow = summary.scenarios[scenarioIndex];
      for (const [promptIndex, prompt] of scenario.prompts.entries()) {
        const promptRow = scenarioRow.prompts[promptIndex];
        const promptHash = sha256(prompt.text);
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const ordinal = summary.totals.executed + 1;
          const sessionKey = `agent:${scenario.agentId}:json-schema-matrix-${safeRunId}-${scenario.name}-${prompt.id}-r${repetition}`;
          let response = null;
          let validation = null;
          let error = null;
          try {
            response = await client.send({
              agentId: scenario.agentId,
              sessionKey,
              prompt: prompt.text,
              expectedReplyCount: 1,
              timeoutMs,
            });
            try {
              validation = await validateResponse(response, scenario);
            } catch (validationError) {
              error = validationError.message;
              validation = { ok: false, errors: [{ code: 'HARNESS_VALIDATION_ERROR', path: '$', message: error }], ingestion: null };
            }
          } catch (invocationError) {
            error = invocationError.message;
            validation = { ok: false, errors: [{ code: 'AGENT_COMMUNICATION_ERROR', path: '$', message: error }], ingestion: null };
          }

          const classification = validation?.ok
            ? 'PASSED'
            : classificationFor({ response, validation, error });
          const record = {
            ordinal,
            scenario: scenario.name,
            schema_file: scenario.schemaFile,
            agent_id: scenario.agentId,
            jsonl: scenario.jsonl,
            prompt_id: prompt.id,
            repetition,
            session_key: sessionKey,
            prompt_sha256: promptHash,
            response,
            validation,
            classification,
            error,
          };
          appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');

          summary.totals.executed += 1;
          scenarioRow.executed += 1;
          promptRow.executed += 1;
          if (validation?.ok) {
            summary.totals.passed += 1;
            scenarioRow.passed += 1;
            promptRow.passed += 1;
          } else {
            summary.totals.failed += 1;
            scenarioRow.failed += 1;
            promptRow.failed += 1;
            const failurePath = join(runRoot, 'failures', `${scenario.name}__${prompt.id}__call-${String(ordinal).padStart(4, '0')}.json`);
            writeJson(failurePath, record);
          }
          promptRow.classifications[classification] = (promptRow.classifications[classification] ?? 0) + 1;
          writeJson(summaryPath, summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned, record });
        }
      }
    }
    summary.run_status = 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    try { client?.close(); } catch (error) {
      if (!abortError) {
        abortError = error;
        summary.run_status = 'ABORTED';
        summary.abort_reason = error.message;
      }
    }
    summary.finished_at = new Date().toISOString();
    writeSummary(runRoot, summary);
  }

  return { ...summary, output_root_abs: runRoot, abort_error: abortError?.message ?? null };
}

function usage() {
  return [
    'Usage: node scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs [options]',
    '',
    'Runs every selected Agent JSON Schema prompt exactly 20 times. Default: 23 schemas × 5 prompts × 20 calls = 2300 Gateway calls.',
    '',
    'Options:',
    '  --scenario <name>          Run one or more stable scenario names; repeatable.',
    '  --run-id <id>              Safe output/session run identifier.',
    '  --output-root <path>       Output root (default: artifacts/agent-json-schema-matrix).',
    '  --timeout-seconds <n>      Per-call timeout in seconds (default: 600).',
    '  --help                     Print this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const result = { scenarioNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') result.help = true;
    else if (token === '--scenario') result.scenarioNames.push(argv[++index]);
    else if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`未知参数：${token}`);
  }
  if (!result.help && result.timeoutMs !== undefined && (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0)) {
    throw new Error('--timeout-seconds 必须为正数。');
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const scenarios = options.scenarioNames.length === 0
    ? JSON_SCHEMA_AGENT_SCENARIOS
    : JSON_SCHEMA_AGENT_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  const unknown = options.scenarioNames.filter((name) => !JSON_SCHEMA_AGENT_SCENARIOS.some((item) => item.name === name));
  if (unknown.length > 0) throw new Error(`未知测试场景：${unknown.join(', ')}`);
  const summary = await runJsonSchemaMatrix({ ...options, scenarios });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status !== 'COMPLETE') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
