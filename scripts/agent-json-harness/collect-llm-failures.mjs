#!/usr/bin/env node
// A single Gateway client exercises registered Agents' final LLM replies.
// The harness never starts OpenClaw processes and never asks an Agent to write.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from './gateway-llm-client.mjs';
import { LLM_SCENARIOS } from './llm-scenarios.mjs';
import { runLlmCase } from './llm-runner.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady } from './runtime-guard-client.mjs';

const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-llm-json');

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runId() {
  return `run-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function failureFolder(outcome) {
  return `${outcome.scenario.name}__${outcome.testCase.id}`;
}

function packagedAttempt(attempt) {
  return {
    attempt: attempt.attempt,
    response_available: attempt.response !== null,
    validation_ok: Boolean(attempt.validation?.ok),
    validation_codes: (attempt.validation?.errors ?? []).map((error) => error.code),
    invocation_error: attempt.error,
  };
}

function packageFailure(runRoot, outcome) {
  const folder = join(runRoot, 'failures', failureFolder(outcome));
  mkdirSync(folder, { recursive: true });
  for (const attempt of outcome.attempts) {
    const extension = outcome.scenario.jsonl ? 'jsonl' : 'json';
    if (attempt.response === null) {
      writeText(join(folder, `attempt${attempt.attempt}-response.missing.txt`), `${attempt.error ?? 'Agent did not return a final reply.'}\n`);
    } else {
      writeText(join(folder, `attempt${attempt.attempt}-response.${extension}`), attempt.response);
    }
    writeText(join(folder, `attempt${attempt.attempt}-prompt.md`), `${attempt.prompt}\n`);
    writeJson(join(folder, `attempt${attempt.attempt}-guard.json`), attempt.validation);
  }
  writeJson(join(folder, 'meta.json'), {
    classification: outcome.classification,
    scenario: outcome.scenario.name,
    schema: `contracts/${outcome.scenario.schemaFile}`,
    case_id: outcome.testCase.id,
    topic: outcome.testCase.topic,
    session_key: outcome.sessionKey,
    attempts: outcome.attempts.map(packagedAttempt),
  });
  return `failures/${failureFolder(outcome)}`;
}

function renderReport(summary) {
  const lines = [
    '# Agent LLM JSON：重写后失败报告', '',
    `- 运行 ID：\`${summary.run_id}\``,
    `- 运行状态：${summary.run_status ?? 'COMPLETE'}`,
    '- 调用路径：现有 OpenClaw Gateway 的单一持久客户端连接',
    '- 测试边界：仅校验注册 Agent 的最终 LLM 回复；不调用 Agent 工具、不要求写文件、不启动 OpenClaw CLI',
    '- 校验器：`scripts/runtime-guard.mjs validate-file`',
    `- 契约场景数：${summary.scenarios.length}`,
    `- 计划用例数：${summary.totals.planned}`,
    `- 已执行用例数：${summary.totals.executed}`,
    `- 首次校验通过：${summary.totals.passed_first}`,
    `- 分类重写后通过（最多两次）：${summary.totals.repair_retry_succeeded}`,
    `- 空输出两次重写后仍失败：${summary.totals.empty_retry_failed}`,
    `- 非空 JSON 两次重写后仍失败：${summary.totals.retry_failed}`,
    `- 已打包供审阅：${summary.totals.packaged}`, '',
    '| 场景 | 计划 | 首次通过 | 分类重写通过 | 空输出失败 | JSON 失败 | 已打包 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  if (summary.abort_reason) lines.splice(3, 0, `- 中止原因：${summary.abort_reason}`);
  for (const item of summary.scenarios) {
    lines.push(`| ${item.name} | ${item.planned} | ${item.passed_first} | ${item.repair_retry_succeeded} | ${item.empty_retry_failed} | ${item.retry_failed} | ${item.packaged} |`);
  }
  lines.push('', '## 已打包的失败项', '');
  for (const item of summary.scenarios) {
    if (item.failures.length === 0) continue;
    lines.push(`### ${item.name}`, '');
    for (const failure of item.failures) {
      lines.push(`- \`${failure.case_id}\` -> \`${failure.folder}\`：${failure.codes.join(', ') || '未解析到校验器错误码'}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function recordOutcome(summary, row, outcome, runRoot) {
  summary.totals.executed += 1;
  row.executed += 1;
  if (outcome.classification === 'PASSED_FIRST') {
    summary.totals.passed_first += 1;
    row.passed_first += 1;
    return;
  }
  if (outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.repair_retry_succeeded += 1;
    row.repair_retry_succeeded += 1;
    return;
  }
  const folder = packageFailure(runRoot, outcome);
  const codes = outcome.attempts.at(-1)?.validation?.errors?.map((error) => error.code) ?? [];
  if (outcome.classification === 'EMPTY_RETRY_FAILED') {
    summary.totals.empty_retry_failed += 1;
    row.empty_retry_failed += 1;
  } else {
    summary.totals.retry_failed += 1;
    row.retry_failed += 1;
  }
  summary.totals.packaged += 1;
  row.packaged += 1;
  row.failures.push({ case_id: outcome.testCase.id, folder, codes });
}

function hasOnlyTransportFailures(outcome) {
  return outcome.attempts.every((attempt) => {
    const errors = attempt.validation?.errors ?? [];
    return errors.length > 0 && errors.every((error) => error.code === 'LLM_INVOCATION_ERROR');
  });
}

export async function collectLlmRun({
  scenarios = LLM_SCENARIOS,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  runId: requestedRunId = runId(),
  timeoutMs = 600000,
  concurrency = 1,
  repetitions = 2,
  connectionBatchSize = 40,
  createClient = connectGatewayLlmClient,
  runCaseImpl = runLlmCase,
  onProgress = () => {},
} = {}) {
  assertRuntimeGuardReady();
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  if (!Number.isInteger(connectionBatchSize) || connectionBatchSize < 1) throw new Error('连接批次大小必须为正整数。');
  const runRoot = resolve(outputRoot, requestedRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });
  const summary = {
    generated_from: 'scripts/agent-json-harness/collect-llm-failures.mjs', run_id: requestedRunId,
    run_status: 'RUNNING',
    scenarios: [],
    totals: { planned: scenarios.reduce((total, item) => total + item.cases.length * repetitions, 0), executed: 0, passed_first: 0, repair_retry_succeeded: 0, empty_retry_failed: 0, retry_failed: 0, packaged: 0 },
  };
  let client = null;
  let abortError = null;
  try {
    client = await createClient();
    const jobs = [];
    for (const scenario of scenarios) {
      const row = { name: scenario.name, schema: `contracts/${scenario.schemaFile}`, agent_id: scenario.agentId, planned: scenario.cases.length * repetitions, executed: 0, passed_first: 0, repair_retry_succeeded: 0, empty_retry_failed: 0, retry_failed: 0, packaged: 0, failures: [] };
      summary.scenarios.push(row);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const testCase of scenario.cases) {
          jobs.push({
            scenario,
            row,
            testCase: { ...testCase, id: `${testCase.id}-r${repetition}`, repetition },
          });
        }
      }
    }
    for (let batchStart = 0; batchStart < jobs.length; batchStart += connectionBatchSize) {
      const batchEnd = Math.min(batchStart + connectionBatchSize, jobs.length);
      let nextJob = batchStart;
      async function worker() {
        while (nextJob < batchEnd) {
          const job = jobs[nextJob++];
          const { scenario, row, testCase } = job;
          const outcome = await runCaseImpl({ client, scenario, testCase, runId: requestedRunId, timeoutMs });
          if (hasOnlyTransportFailures(outcome)) {
            throw new Error(`Gateway 传输失败，未将其计为 LLM 失败：${scenario.name}/${testCase.id}`);
          }
          recordOutcome(summary, row, outcome, runRoot);
          writeJson(join(runRoot, 'summary.json'), summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned });
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batchEnd - batchStart) }, () => worker()));
      if (batchEnd < jobs.length && typeof client.reconnect === 'function') await client.reconnect();
    }
    summary.run_status = 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    client?.close();
  }
  writeJson(join(runRoot, 'summary.json'), summary);
  writeText(join(runRoot, 'report.md'), renderReport(summary));
  if (abortError) throw abortError;
  return { ...summary, output_root_abs: runRoot };
}

function parseArgs(argv) {
  const result = { scenarioNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--scenario') result.scenarioNames.push(argv[++index]);
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else if (token === '--concurrency') result.concurrency = Number(argv[++index]);
    else if (token === '--repetitions') result.repetitions = Number(argv[++index]);
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isFinite(result.timeoutMs ?? 600000) || (result.timeoutMs ?? 600000) <= 0) throw new Error('--timeout-seconds 必须为正数。');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0 ? LLM_SCENARIOS : LLM_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  if (scenarios.length === 0) throw new Error('没有匹配的测试场景。');
  const summary = await collectLlmRun({ ...options, scenarios, onProgress: ({ completed, planned }) => {
    if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个 LLM 用例。\n`);
  } });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
