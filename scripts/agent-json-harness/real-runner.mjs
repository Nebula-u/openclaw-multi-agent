// Executes one planned contract case through a real registered OpenClaw Agent.
// The runner owns prompts and evidence capture only. It never creates or fixes
// the contract artifact itself.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PROJECT_ROOT, schemaPath, validateFile } from './guard.mjs';
import { buildRealCasePrompt, buildRetryPrompt } from './real-scenarios.mjs';

const RETRY_TEMPLATE_PATH = join(PROJECT_ROOT, 'templates', 'json-regeneration-retry-prompt.md');

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function caseSessionKey({ scenario, testCase, runId }) {
  return `agent:${scenario.agentId}:agent-json-${runId}-${scenario.name}-${testCase.id}`;
}

// `openclaw agent` may fork a TUI child that inherits stdout/stderr. Killing
// only the CLI parent leaves those pipes open and makes Node wait forever for
// the `close` event. A detached group lets the runner terminate that whole
// invocation without affecting the Gateway or other test cases.
export function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if (fallbackError.code !== 'ESRCH') throw fallbackError;
    }
  }
}

export function invokeOpenClaw({ agentId, sessionKey, promptPath, timeoutSeconds = 600 }) {
  return new Promise((resolve) => {
    const child = spawn('openclaw', [
      'agent',
      '--agent', agentId,
      '--session-key', sessionKey,
      '--message-file', promptPath,
      '--json',
      '--timeout', String(timeoutSeconds),
    ], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 1500);
    }, timeoutSeconds * 1000);
    const timeoutTimer = timer;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr: `${stderr}${error.message}\n`, timedOut });
    });
    child.on('close', (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function snapshotArtifact(artifactPath, snapshotPath) {
  if (existsSync(artifactPath)) {
    copyFileSync(artifactPath, snapshotPath);
    return { exists: true, path: snapshotPath };
  }
  const missingPath = `${snapshotPath}.missing.txt`;
  writeText(missingPath, `Agent did not create the expected artifact: ${artifactPath}\n`);
  return { exists: false, path: missingPath };
}

function captureAttempt({ attempt, artifactPath, artifactSnapshotPath, rawDirectory, schemaFile, jsonl, invocation }) {
  writeText(join(rawDirectory, `agent-response-attempt${attempt}.stdout.txt`), invocation.stdout ?? '');
  writeText(join(rawDirectory, `agent-response-attempt${attempt}.stderr.txt`), invocation.stderr ?? '');
  const artifact = snapshotArtifact(artifactPath, artifactSnapshotPath);
  const validation = validateFile(artifactPath, { schemaFile, jsonl });
  writeJson(join(rawDirectory, `guard-attempt${attempt}.json`), validation);
  return {
    attempt,
    invocation,
    artifactExists: artifact.exists,
    artifactSnapshotPath: artifact.path,
    validation,
  };
}

export async function runCase({ scenario, testCase, caseDirectory, runId }, options = {}) {
  const inputDirectory = join(caseDirectory, 'input');
  const outputDirectory = join(caseDirectory, 'output');
  const rawDirectory = join(caseDirectory, 'raw');
  mkdirSync(inputDirectory, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(rawDirectory, { recursive: true });

  const artifactPath = join(outputDirectory, scenario.artifactFileName);
  const contractPath = schemaPath(scenario.schemaFile);
  const contextPath = join(inputDirectory, 'context.md');
  const promptPath = join(inputDirectory, 'agent-prompt.md');
  const sessionKey = caseSessionKey({ scenario, testCase, runId });
  writeText(contextPath, [
    '# Real Agent JSON Harness Context',
    '',
    `- Scenario: ${scenario.name}`,
    `- Contract schema: ${scenario.schemaFile}`,
    `- Case: ${testCase.id}`,
    `- Topic: ${testCase.topic}`,
    `- Requirement: ${testCase.requirement}`,
    `- Variation number: ${testCase.variation}`,
    '',
  ].join('\n'));
  writeText(promptPath, buildRealCasePrompt(scenario, testCase, {
    artifactPath,
    schemaPath: contractPath,
    contextPath,
  }));

  const invokeAgent = options.invokeAgent ?? (async (input) => invokeOpenClaw(input));
  const commonInput = {
    agentId: scenario.agentId,
    sessionKey,
    artifactPath,
    timeoutSeconds: options.timeoutSeconds ?? 600,
  };
  const attempt1 = captureAttempt({
    attempt: 1,
    artifactPath,
    artifactSnapshotPath: join(outputDirectory, `output.attempt1.${scenario.jsonl ? 'jsonl' : 'json'}`),
    rawDirectory,
    schemaFile: scenario.schemaFile,
    jsonl: scenario.jsonl,
    invocation: await invokeAgent({ ...commonInput, attempt: 1, promptPath }),
  });
  if (attempt1.validation.ok) {
    return { classification: 'PASSED_FIRST', scenario, testCase, caseDirectory, sessionKey, attempts: [attempt1] };
  }

  const errorLogPath = join(rawDirectory, 'guard-attempt1.json');
  const retryPromptPath = join(rawDirectory, 'retry-prompt.md');
  writeText(retryPromptPath, buildRetryPrompt({
    artifactPath,
    schemaPath: contractPath,
    errorLogPath,
    retryTemplate: readFileSync(RETRY_TEMPLATE_PATH, 'utf8'),
  }));
  const attempt2 = captureAttempt({
    attempt: 2,
    artifactPath,
    artifactSnapshotPath: join(outputDirectory, `output.attempt2.${scenario.jsonl ? 'jsonl' : 'json'}`),
    rawDirectory,
    schemaFile: scenario.schemaFile,
    jsonl: scenario.jsonl,
    invocation: await invokeAgent({ ...commonInput, attempt: 2, promptPath: retryPromptPath }),
  });
  return {
    classification: attempt2.validation.ok ? 'RETRY_SUCCEEDED' : 'RETRY_FAILED',
    scenario,
    testCase,
    caseDirectory,
    sessionKey,
    retryPromptPath,
    attempts: [attempt1, attempt2],
  };
}
