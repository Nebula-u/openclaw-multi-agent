#!/usr/bin/env node

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectLlmRun } from './collect-llm-failures.mjs';
import { REPETITIONS_PER_CASE, TEST_AGENT_LLM_SCENARIOS } from './llm-scenarios.mjs';
import { PROJECT_ROOT } from './runtime-guard-client.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else if (token === '--concurrency') result.concurrency = Number(argv[++index]);
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--repetitions') throw new Error(`测试矩阵固定为每个样例 ${REPETITIONS_PER_CASE} 次，不接受 --repetitions。`);
    else throw new Error(`未知参数：${token}`);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await collectLlmRun({ ...options, scenarios: TEST_AGENT_LLM_SCENARIOS,
    repetitions: REPETITIONS_PER_CASE, outputRoot: join(PROJECT_ROOT, 'artifacts', 'agent-json-workflow-test-agent'),
    onProgress: ({ completed, planned }) => { if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个 test-agent 逻辑测试。\n`); } });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status === 'INCOMPLETE') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
