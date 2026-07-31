#!/usr/bin/env node
// Full live-run collector. Every contract artifact is written by a real Agent
// through real-runner; this module only schedules runs and packages evidence.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './guard.mjs';
import { REAL_SCENARIOS } from './real-scenarios.mjs';
import { runCase } from './real-runner.mjs';

const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-json-real');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueRunId() {
  return `run-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function caseFolderName(scenario, testCase) {
  return `${scenario.name}__${testCase.id}`;
}

function outcomeMeta(outcome) {
  return {
    classification: outcome.classification,
    scenario: outcome.scenario.name,
    schema: `contracts/${outcome.scenario.schemaFile}`,
    case_id: outcome.testCase.id,
    topic: outcome.testCase.topic,
    session_key: outcome.sessionKey ?? null,
    retry_prompt_path: outcome.retryPromptPath ?? null,
    attempts: outcome.attempts.map((attempt) => ({
      attempt: attempt.attempt ?? null,
      artifact_exists: attempt.artifactExists ?? null,
      artifact_snapshot_path: attempt.artifactSnapshotPath ?? null,
      validation_ok: Boolean(attempt.validation?.ok),
      validation_codes: attempt.validation?.codes ?? [],
      invocation: attempt.invocation ? {
        exit_code: attempt.invocation.exitCode,
        timed_out: Boolean(attempt.invocation.timedOut),
      } : null,
    })),
  };
}

function recordOutcome(summary, scenarioRow, outcome, runRoot) {
  summary.totals.executed += 1;
  if (outcome.classification === 'PASSED_FIRST') {
    summary.totals.passed_first += 1;
    scenarioRow.passed_first += 1;
  } else if (outcome.classification === 'RETRY_SUCCEEDED') {
    summary.totals.retry_succeeded += 1;
    scenarioRow.retry_succeeded += 1;
  } else {
    summary.totals.retry_failed += 1;
    scenarioRow.retry_failed += 1;
    const source = outcome.caseDirectory;
    const folder = caseFolderName(outcome.scenario, outcome.testCase);
    const destination = join(runRoot, 'failures', folder);
    if (!existsSync(destination)) cpSync(source, destination, { recursive: true, errorOnExist: true });
    writeJson(join(destination, 'meta.json'), outcomeMeta(outcome));
    summary.totals.packaged += 1;
    scenarioRow.packaged += 1;
    scenarioRow.failures.push({
      case_id: outcome.testCase.id,
      folder: `failures/${folder}`,
      codes: outcome.attempts.at(-1)?.validation?.codes ?? [],
    });
  }
}

function renderReport(summary) {
  const lines = [
    '# Real Agent JSON — post-rewrite failure report',
    '',
    `- Run ID: \`${summary.run_id}\``,
    '- Agent invocation: `openclaw agent --agent <registered-role> --json`',
    '- Validator: `scripts/runtime-guard.mjs validate-file`',
    `- Contract scenarios: ${summary.scenarios.length}`,
    `- Planned cases: ${summary.totals.planned}`,
    `- Executed cases: ${summary.totals.executed}`,
    `- Passed first validation: ${summary.totals.passed_first}`,
    `- Rewritten successfully: ${summary.totals.retry_succeeded}`,
    `- Still failing after one real-agent rewrite: ${summary.totals.retry_failed}`,
    `- Packaged for review: ${summary.totals.packaged}`,
    '',
    '| Scenario | planned | passed first | retry ok | retry failed | packaged |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const scenario of summary.scenarios) {
    lines.push(`| ${scenario.name} | ${scenario.planned} | ${scenario.passed_first} | ${scenario.retry_succeeded} | ${scenario.retry_failed} | ${scenario.packaged} |`);
  }
  lines.push('', '## Packaged failures', '');
  for (const scenario of summary.scenarios) {
    if (scenario.failures.length === 0) continue;
    lines.push(`### ${scenario.name}`, '');
    for (const failure of scenario.failures) {
      lines.push(`- \`${failure.case_id}\` → \`${failure.folder}\` — ${failure.codes.join(', ') || 'no parsed validator code'}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function loadExistingOutcome(metaPath, scenario, testCase, caseDirectory) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  return {
    classification: meta.classification,
    scenario,
    testCase,
    caseDirectory,
    sessionKey: meta.session_key,
    retryPromptPath: meta.retry_prompt_path,
    attempts: meta.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      artifactExists: attempt.artifact_exists,
      artifactSnapshotPath: attempt.artifact_snapshot_path,
      validation: { ok: attempt.validation_ok, codes: attempt.validation_codes },
      invocation: attempt.invocation ? { exitCode: attempt.invocation.exit_code, timedOut: attempt.invocation.timed_out } : null,
    })),
  };
}

export async function collectRun({
  scenarios = REAL_SCENARIOS,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  runId = uniqueRunId(),
  resume = false,
  timeoutSeconds = 600,
  concurrency = 4,
  runCaseImpl = runCase,
  onProgress = () => {},
} = {}) {
  const runRoot = resolve(outputRoot, runId);
  if (existsSync(runRoot) && !resume) {
    throw new Error(`Run directory already exists: ${runRoot}. Use --resume to continue it.`);
  }
  mkdirSync(join(runRoot, 'cases'), { recursive: true });
  mkdirSync(join(runRoot, 'failures'), { recursive: true });

  const summary = {
    generated_from: 'scripts/agent-json-harness/collect-real-failures.mjs',
    run_id: runId,
    output_root_abs: runRoot,
    scenarios: [],
    totals: {
      planned: scenarios.reduce((total, scenario) => total + scenario.cases.length, 0),
      executed: 0,
      passed_first: 0,
      retry_succeeded: 0,
      retry_failed: 0,
      packaged: 0,
    },
  };

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const jobs = [];
  for (const scenario of scenarios) {
    const scenarioRow = {
      name: scenario.name,
      schema: `contracts/${scenario.schemaFile}`,
      agent_id: scenario.agentId,
      planned: scenario.cases.length,
      passed_first: 0,
      retry_succeeded: 0,
      retry_failed: 0,
      packaged: 0,
      failures: [],
    };
    summary.scenarios.push(scenarioRow);
    for (const testCase of scenario.cases) {
      jobs.push({ scenario, scenarioRow, testCase });
    }
  }
  let nextJob = 0;
  async function worker() {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      const { scenario, scenarioRow, testCase } = job;
      const caseDirectory = join(runRoot, 'cases', caseFolderName(scenario, testCase));
      mkdirSync(join(caseDirectory, 'output'), { recursive: true });
      const metaPath = join(caseDirectory, 'meta.json');
      const outcome = resume && existsSync(metaPath)
        ? loadExistingOutcome(metaPath, scenario, testCase, caseDirectory)
        : await runCaseImpl({ scenario, testCase, caseDirectory, runId }, { timeoutSeconds });
      writeJson(metaPath, outcomeMeta(outcome));
      recordOutcome(summary, scenarioRow, outcome, runRoot);
      onProgress({ scenario, testCase, outcome, completed: summary.totals.executed, planned: summary.totals.planned });
      writeJson(join(runRoot, 'summary.json'), summary);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  writeJson(join(runRoot, 'summary.json'), summary);
  writeFileSync(join(runRoot, 'report.md'), renderReport(summary), 'utf8');
  return summary;
}

function parseArgs(argv) {
  const options = { scenarioNames: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--resume') options.resume = true;
    else if (value === '--run-id') options.runId = argv[++i];
    else if (value === '--scenario') options.scenarioNames.push(argv[++i]);
    else if (value === '--timeout-seconds') options.timeoutSeconds = Number(argv[++i]);
    else if (value === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (value === '--output-root') options.outputRoot = argv[++i];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isFinite(options.timeoutSeconds ?? 600) || (options.timeoutSeconds ?? 600) <= 0) {
    throw new Error('--timeout-seconds must be a positive number');
  }
  if (!Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4) < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0
    ? REAL_SCENARIOS
    : REAL_SCENARIOS.filter((scenario) => options.scenarioNames.includes(scenario.name));
  if (scenarios.length === 0) throw new Error('No scenario matched --scenario.');
  const summary = await collectRun({
    scenarios,
    runId: options.runId,
    outputRoot: options.outputRoot,
    resume: options.resume,
    timeoutSeconds: options.timeoutSeconds,
    concurrency: options.concurrency,
    onProgress: ({ completed, planned }) => {
      if (completed % 30 === 0 || completed === planned) {
        process.stdout.write(`Completed ${completed}/${planned} real-agent cases.\n`);
      }
    },
  });
  process.stdout.write(`Final report: ${join(summary.output_root_abs, 'report.md')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
