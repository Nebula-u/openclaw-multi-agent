#!/usr/bin/env node
// Gateway-only Agent JSON workflow matrix. It never starts OpenClaw processes
// and never asks an Agent to read/write a workspace.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from './gateway-llm-client.mjs';
import { NON_TEST_AGENT_LLM_SCENARIOS, REPETITIONS_PER_CASE } from './llm-scenarios.mjs';
import { runLlmCase } from './llm-runner.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady } from './runtime-guard-client.mjs';

const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-json-workflow');

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runId() {
  return `schema-matrix-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function failureFolder(outcome) {
  return `${outcome.scenario.name}__${outcome.testCase.id}`;
}

const ERROR_LABELS = {
  LLM_INVOCATION_ERROR: 'Gateway 或 Agent 通信失败',
  AGENT_COMMUNICATION_ERROR: 'Gateway 或 Agent 通信失败',
  AGENT_NO_TEXT_RESPONSE: 'Agent 未返回文本内容',
  EMPTY_RESPONSE: '空回复',
  OUTPUT_TRUNCATED: 'JSON 输出截断',
  JSON_PARSE_ERROR: 'JSON 语法错误',
  JSON_READ_ERROR: 'JSON 读取错误',
  JSONL_EMPTY: 'JSONL 为空',
  SCHEMA_REQUIRED: '缺少必填字段',
  SCHEMA_ADDITIONAL_PROPERTY: '字段名错误或额外字段',
  SCHEMA_TYPE: '字段类型错误',
  SCHEMA_ENUM: '枚举值错误',
  SCHEMA_CONST: '常量约束错误',
  SCHEMA_FORMAT: '字段格式错误',
  SCHEMA_PATTERN: '字段格式模式错误',
  SCHEMA_MIN_ITEMS: '数组项目数量不足',
  SCHEMA_MIN_LENGTH: '字段长度不足',
  SCHEMA_MINIMUM: '数值范围错误',
  SCHEMA_UNIQUE_ITEMS: '数组存在重复项目',
};

function normalizedIssues(attempt) {
  const validation = attempt.validation ?? {};
  const guardIssues = validation.errors ?? [];
  if (attempt.error) return [{ code: 'LLM_INVOCATION_ERROR', category: ERROR_LABELS.LLM_INVOCATION_ERROR, path: '$', message: attempt.error, params: {} }];
  if (validation.ingestion?.error) {
    const code = validation.ingestion.error.diagnostic ?? 'JSON_PARSE_ERROR';
    return [{ code, category: ERROR_LABELS[code] ?? 'JSON 清洗或解析错误', path: '$', message: validation.ingestion.error.message, params: {} },
      ...guardIssues.map((item) => issueFromGuard(item))];
  }
  return guardIssues.map((item) => issueFromGuard(item));
}

function issueFromGuard(item) {
  const code = item.code ?? (item.schema_keyword ? `SCHEMA_${String(item.schema_keyword).toUpperCase()}` : 'SCHEMA_VALIDATION_ERROR');
  return {
    code,
    category: ERROR_LABELS[code] ?? 'Schema 约束错误',
    path: item.path ?? item.instancePath ?? '$',
    message: item.message ?? 'JSON Schema 校验失败',
    params: item.params ?? {},
  };
}

function packageInvalidAttempts(runRoot, outcome) {
  const files = [];
  for (const attempt of outcome.attempts.filter((item) => !item.validation?.ok)) {
    const folder = join(runRoot, 'failures', failureFolder(outcome), `attempt-${attempt.attempt}`);
    const relativeFolder = join('failures', failureFolder(outcome), `attempt-${attempt.attempt}`).replaceAll('\\', '/');
    if (attempt.response === null) writeText(join(folder, 'raw-response.missing.txt'), `${attempt.error ?? 'Agent did not return a final reply.'}\n`);
    else writeText(join(folder, 'raw-response.txt'), attempt.response);
    const cleaned = attempt.validation?.ingestion?.cleaned_text;
    if (typeof cleaned === 'string') writeText(join(folder, outcome.scenario.jsonl ? 'cleaned-response.jsonl' : 'cleaned-response.json'), cleaned);
    writeText(join(folder, 'prompt.md'), `${attempt.prompt}\n`);
    if (attempt.attempt > 1) writeText(join(folder, 'retry-prompt.md'), `${attempt.prompt}\n`);
    writeJson(join(folder, 'ingestion.json'), attempt.validation?.ingestion ?? null);
    writeJson(join(folder, 'validation.json'), attempt.validation ?? null);
    const diagnosis = { schema: `contracts/${outcome.scenario.schemaFile}`, scenario: outcome.scenario.name,
      case_id: outcome.testCase.id, iteration: outcome.testCase.repetition ?? null, attempt: attempt.attempt,
      issues: normalizedIssues(attempt) };
    writeJson(join(folder, 'diagnosis.json'), diagnosis);
    files.push({ folder: relativeFolder, issues: diagnosis.issues });
  }
  return files;
}

function freshRow(scenario, repetitions) {
  return { name: scenario.name, schema: `contracts/${scenario.schemaFile}`, agent_id: scenario.agentId,
    planned: scenario.cases.length * repetitions, executed: 0, strict_raw_first_passed: 0, cleaned_first_passed: 0,
    repair_retry_succeeded: 0, final_passed: 0, final_failed: 0, transport_failures: 0, packaged: 0,
    final_pass_rate: null, error_categories: {}, failures: [] };
}

function incrementCategories(row, packages) {
  for (const item of packages) {
    for (const issue of item.issues) row.error_categories[issue.category] = (row.error_categories[issue.category] ?? 0) + 1;
  }
}

function firstAttemptIsStrictlyValid(outcome) {
  const first = outcome.attempts[0];
  return Boolean(first?.validation?.ok && (first.validation.ingestion?.transformations ?? []).length === 0);
}

function finalizeRates(summary) {
  for (const row of summary.scenarios) {
    const qualityCompleted = row.executed - row.transport_failures;
    row.final_pass_rate = qualityCompleted === 0 ? null : row.final_passed / qualityCompleted;
  }
  const qualityCompleted = summary.totals.executed - summary.totals.transport_failures;
  summary.totals.final_pass_rate = qualityCompleted === 0 ? null : summary.totals.final_passed / qualityCompleted;
}

function renderRate(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function completedForQuality(row) {
  return row.executed - row.transport_failures;
}

function renderReport(summary) {
  const lines = [
    '# Agent JSON 生成与清洗工作流测试报告', '',
    `- 运行 ID：\`${summary.run_id}\``, `- 运行状态：${summary.run_status}`,
    '- 测试边界：仅通过 OpenClaw Gateway 检查注册 Agent 的最终 JSON/JSONL 回复；不调用工具、不读写工作区。',
    '- 每个 Schema 固定 3 个测试样例，每样例固定 10 次；首次失败在相同会话内最多修复 2 次。',
    '- 清洗器：生产同源 `ingestJsonText`；校验器：Runtime Guard + Ajv。',
    `- 计划逻辑测试：${summary.totals.planned}；已执行：${summary.totals.executed}；通信异常：${summary.totals.transport_failures}。`,
    `- 总体正确率：${renderRate(summary.totals.final_pass_rate)}（通过次数 ${summary.totals.final_passed} / 有效执行 ${completedForQuality(summary.totals)}；通信异常不计入质量分母）。`, '',
    '| Schema | Agent 分类 | 计划 | 执行 | 通过次数 | 正确率 | 原始首轮通过 | 清洗后首轮通过 | 修复成功 | 终态失败 | 通信异常 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of summary.scenarios) lines.push(`| ${row.name} | ${row.agent_id} | ${row.planned} | ${row.executed} | ${row.final_passed} / ${completedForQuality(row)} | ${renderRate(row.final_pass_rate)} | ${row.strict_raw_first_passed} | ${row.cleaned_first_passed} | ${row.repair_retry_succeeded} | ${row.final_failed} | ${row.transport_failures} |`);
  lines.push('', '## 错误分类', '');
  for (const row of summary.scenarios) {
    const categories = Object.entries(row.error_categories);
    if (categories.length === 0) continue;
    lines.push(`### ${row.name}`, '');
    for (const [category, count] of categories) lines.push(`- ${category}：${count}`);
    lines.push('');
  }
  lines.push('## 失败原件', '', '每个无效尝试（包括后续修复成功前的失败）均位于 `failures/`；目录保存原始回复、清洗结果、提示、校验结果和中文诊断。');
  return `${lines.join('\n')}\n`;
}

function recordOutcome(summary, row, outcome, runRoot) {
  summary.totals.executed += 1;
  row.executed += 1;
  const packages = packageInvalidAttempts(runRoot, outcome);
  summary.totals.packaged += packages.length;
  row.packaged += packages.length;
  incrementCategories(row, packages);
  if (packages.length) row.failures.push({ case_id: outcome.testCase.id, iteration: outcome.testCase.repetition ?? null,
    folders: packages.map((item) => item.folder), categories: packages.flatMap((item) => item.issues.map((issue) => issue.category)) });
  if (outcome.classification === 'TRANSPORT_FAILURE') {
    summary.totals.transport_failures += 1;
    row.transport_failures += 1;
    return;
  }
  if (firstAttemptIsStrictlyValid(outcome)) {
    summary.totals.strict_raw_first_passed += 1;
    row.strict_raw_first_passed += 1;
  }
  if (outcome.attempts[0]?.validation?.ok) {
    summary.totals.cleaned_first_passed += 1;
    row.cleaned_first_passed += 1;
  }
  if (outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.repair_retry_succeeded += 1;
    row.repair_retry_succeeded += 1;
  }
  if (outcome.classification === 'PASSED_FIRST' || outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.final_passed += 1;
    row.final_passed += 1;
  } else {
    summary.totals.final_failed += 1;
    row.final_failed += 1;
  }
}

export async function collectLlmRun({
  scenarios = NON_TEST_AGENT_LLM_SCENARIOS, outputRoot = DEFAULT_OUTPUT_ROOT, runId: requestedRunId = runId(), timeoutMs = 600000,
  concurrency = 1, repetitions = REPETITIONS_PER_CASE, connectionBatchSize = 40, createClient = connectGatewayLlmClient,
  runCaseImpl = runLlmCase, onProgress = () => {},
} = {}) {
  assertRuntimeGuardReady();
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  if (!Number.isInteger(connectionBatchSize) || connectionBatchSize < 1) throw new Error('连接批次大小必须为正整数。');
  const runRoot = resolve(outputRoot, requestedRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });
  const summary = { generated_from: 'scripts/agent-json-harness/collect-llm-failures.mjs', run_id: requestedRunId,
    run_status: 'RUNNING', repetitions_per_case: repetitions, scenarios: [],
    totals: { planned: scenarios.reduce((total, item) => total + item.cases.length * repetitions, 0), executed: 0,
      strict_raw_first_passed: 0, cleaned_first_passed: 0, repair_retry_succeeded: 0, final_passed: 0,
      final_failed: 0, transport_failures: 0, packaged: 0, final_pass_rate: null } };
  let client = null;
  let abortError = null;
  try {
    client = await createClient();
    const jobs = [];
    for (const scenario of scenarios) {
      const row = freshRow(scenario, repetitions);
      summary.scenarios.push(row);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const testCase of scenario.cases) jobs.push({ scenario, row, testCase: { ...testCase, id: `${testCase.id}-r${repetition}`, repetition } });
      }
    }
    for (let batchStart = 0; batchStart < jobs.length; batchStart += connectionBatchSize) {
      const batchEnd = Math.min(batchStart + connectionBatchSize, jobs.length);
      let nextJob = batchStart;
      async function worker() {
        while (nextJob < batchEnd) {
          const job = jobs[nextJob++];
          const outcome = await runCaseImpl({ client, scenario: job.scenario, testCase: job.testCase, runId: requestedRunId, timeoutMs });
          recordOutcome(summary, job.row, outcome, runRoot);
          finalizeRates(summary);
          writeJson(join(runRoot, 'summary.json'), summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned });
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batchEnd - batchStart) }, () => worker()));
      if (batchEnd < jobs.length && typeof client.reconnect === 'function') await client.reconnect();
    }
    summary.run_status = summary.totals.transport_failures > 0 ? 'INCOMPLETE' : 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    client?.close();
  }
  finalizeRates(summary);
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
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else if (token === '--repetitions') throw new Error(`测试矩阵固定为每个样例 ${REPETITIONS_PER_CASE} 次，不接受 --repetitions。`);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isFinite(result.timeoutMs ?? 600000) || (result.timeoutMs ?? 600000) <= 0) throw new Error('--timeout-seconds 必须为正数。');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0 ? NON_TEST_AGENT_LLM_SCENARIOS : NON_TEST_AGENT_LLM_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  if (scenarios.length === 0) throw new Error('没有匹配的测试场景。');
  const summary = await collectLlmRun({ ...options, scenarios, repetitions: REPETITIONS_PER_CASE, onProgress: ({ completed, planned }) => {
    if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个逻辑测试。\n`);
  } });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status === 'INCOMPLETE') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
