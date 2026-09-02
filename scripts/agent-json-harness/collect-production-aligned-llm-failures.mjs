#!/usr/bin/env node
// Production-aligned comparison matrix.  It intentionally leaves all prior
// collectors and free-generation test cases untouched.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectLlmRun } from './collect-llm-failures.mjs';
import { PRODUCTION_ALIGNED_LLM_SCENARIOS, REPETITIONS_PER_CASE } from './production-aligned-llm-scenarios.mjs';
import { runProductionAlignedLlmCase } from './production-aligned-llm-runner.mjs';
import { PROJECT_ROOT } from './runtime-guard-client.mjs';

function parseArgs(argv) {
  const result = { scenarioNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--scenario') result.scenarioNames.push(argv[++index]);
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else if (token === '--concurrency') result.concurrency = Number(argv[++index]);
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--repetitions') throw new Error(`测试矩阵固定为每个样例 ${REPETITIONS_PER_CASE} 次，不接受 --repetitions。`);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isFinite(result.timeoutMs ?? 600000) || (result.timeoutMs ?? 600000) <= 0) throw new Error('--timeout-seconds 必须为正数。');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0
    ? PRODUCTION_ALIGNED_LLM_SCENARIOS
    : PRODUCTION_ALIGNED_LLM_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  if (scenarios.length === 0) throw new Error('没有匹配的生产环境对齐测试场景。');
  const summary = await collectLlmRun({
    ...options,
    scenarios,
    runCaseImpl: runProductionAlignedLlmCase,
    repetitions: REPETITIONS_PER_CASE,
    outputRoot: join(PROJECT_ROOT, 'artifacts', 'agent-json-workflow-production-aligned'),
    onProgress: ({ completed, planned }) => { if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个生产环境对齐逻辑测试。\n`); },
  });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status === 'INCOMPLETE') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
