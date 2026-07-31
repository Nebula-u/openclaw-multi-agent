import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

import { REAL_SCENARIOS, buildRealCasePrompt } from '../scripts/agent-json-harness/real-scenarios.mjs';
import { killProcessGroup, runCase } from '../scripts/agent-json-harness/real-runner.mjs';
import { collectRun } from '../scripts/agent-json-harness/collect-real-failures.mjs';

const EXPECTED_SCHEMAS = [
  'acceptance-criteria.schema.json',
  'active-workflows.schema.json',
  'agent-package.schema.json',
  'approval-request.schema.json',
  'approval-response.schema.json',
  'command-record.schema.json',
  'component-build-result.schema.json',
  'component-request.schema.json',
  'context-manifest.schema.json',
  'evidence.schema.json',
  'gate-result.schema.json',
  'json-validation-error.schema.json',
  'release-decision.schema.json',
  'result.schema.json',
  'review-findings.schema.json',
  'skill-package.schema.json',
  'task.schema.json',
  'workflow-event.schema.json',
  'workflow.schema.json',
];

test('real scenario matrix covers every contract with 30 distinct real-agent requests', () => {
  assert.deepEqual(
    REAL_SCENARIOS.map((scenario) => scenario.schemaFile).sort(),
    [...EXPECTED_SCHEMAS].sort(),
  );

  for (const scenario of REAL_SCENARIOS) {
    assert.ok(scenario.agentId.length > 0, `${scenario.schemaFile} needs a real agent`);
    assert.ok(scenario.artifactFileName.endsWith(scenario.jsonl ? '.jsonl' : '.json'));
    assert.equal(scenario.cases.length, 30, `${scenario.schemaFile} must have exactly 30 cases`);
    assert.equal(new Set(scenario.cases.map((item) => item.id)).size, 30);
    assert.equal(new Set(scenario.cases.map((item) => item.topic)).size, 30);
  }
});

test('real agent prompt requests an artifact rather than embedding a copied template payload', () => {
  const scenario = REAL_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const prompt = buildRealCasePrompt(scenario, scenario.cases[0], {
    artifactPath: '/tmp/agent-output.json',
    schemaPath: '/repo/contracts/result.schema.json',
    contextPath: '/tmp/context.md',
  });

  assert.match(prompt, /\/tmp\/agent-output\.json/);
  assert.match(prompt, /\/repo\/contracts\/result\.schema\.json/);
  assert.match(prompt, /do not copy any shipped template/i);
  assert.doesNotMatch(prompt, /"schema_version"\s*:/);
});

test('a real-run failure gets one same-session retry and snapshots both agent artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'real-agent-runner-'));
  const scenario = REAL_SCENARIOS.find((item) => item.schemaFile === 'acceptance-criteria.schema.json');
  const calls = [];

  const outcome = await runCase({
    scenario,
    testCase: scenario.cases[0],
    caseDirectory: root,
    runId: 'unit-run',
  }, {
    invokeAgent: async ({ artifactPath, sessionKey, attempt }) => {
      calls.push({ sessionKey, attempt });
      writeFileSync(artifactPath, '{}\n', 'utf8');
      return { exitCode: 0, stdout: `agent attempt ${attempt}`, stderr: '' };
    },
  });

  assert.equal(outcome.classification, 'RETRY_FAILED');
  assert.deepEqual(calls.map((call) => call.attempt), [1, 2]);
  assert.equal(calls[0].sessionKey, calls[1].sessionKey);
  assert.equal(readFileSync(outcome.attempts[0].artifactSnapshotPath, 'utf8'), '{}\n');
  assert.equal(readFileSync(outcome.attempts[1].artifactSnapshotPath, 'utf8'), '{}\n');
  assert.equal(outcome.attempts[0].validation.ok, false);
  assert.equal(outcome.attempts[1].validation.ok, false);
});

test('collector packages every post-retry failure without a scenario cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'real-agent-collector-'));
  const scenario = {
    name: 'uncapped', schemaFile: 'result.schema.json', agentId: 'developer-agent', jsonl: false,
    artifactFileName: 'artifact.json',
    cases: [1, 2, 3, 4].map((number) => ({ id: `case-${number}`, topic: `topic-${number}` })),
  };
  const summary = await collectRun({
    scenarios: [scenario], outputRoot: root, runId: 'uncapped-run',
    runCaseImpl: async ({ caseDirectory, testCase }) => {
      writeFileSync(join(caseDirectory, 'output.attempt1.json'), `{\"attempt\":1,\"case\":\"${testCase.id}\"}\n`);
      writeFileSync(join(caseDirectory, 'output.attempt2.json'), `{\"attempt\":2,\"case\":\"${testCase.id}\"}\n`);
      return {
        classification: 'RETRY_FAILED',
        scenario,
        testCase,
        caseDirectory,
        attempts: [
          { validation: { ok: false, codes: ['SCHEMA_REQUIRED'] } },
          { validation: { ok: false, codes: ['SCHEMA_REQUIRED'] } },
        ],
      };
    },
  });

  assert.equal(summary.totals.retry_failed, 4);
  assert.equal(summary.totals.packaged, 4);
  for (const number of [1, 2, 3, 4]) {
    const folder = join(root, 'uncapped-run', 'failures', `uncapped__case-${number}`);
    assert.ok(existsSync(join(folder, 'output.attempt1.json')));
    assert.ok(existsSync(join(folder, 'output.attempt2.json')));
  }
  assert.match(readFileSync(join(root, 'uncapped-run', 'report.md'), 'utf8'), /Packaged for review: 4/);
});

test('timeout cleanup terminates the whole detached CLI process group', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/hold-process-group.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  killProcessGroup(child.pid, 'SIGTERM');
  const [exitCode, signal] = await once(child, 'close');
  assert.equal(exitCode, null);
  assert.equal(signal, 'SIGTERM');
});

test('collector respects the configured concurrency while executing all cases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'real-agent-concurrency-'));
  const scenario = {
    name: 'parallel', schemaFile: 'result.schema.json', agentId: 'developer-agent', jsonl: false,
    artifactFileName: 'artifact.json',
    cases: Array.from({ length: 6 }, (_, index) => ({ id: `case-${index + 1}`, topic: `topic-${index + 1}` })),
  };
  let active = 0;
  let maximumActive = 0;
  const summary = await collectRun({
    scenarios: [scenario], outputRoot: root, runId: 'parallel-run', concurrency: 3,
    runCaseImpl: async ({ scenario: activeScenario, testCase, caseDirectory }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        classification: 'PASSED_FIRST', scenario: activeScenario, testCase, caseDirectory,
        attempts: [{ validation: { ok: true, codes: [] } }],
      };
    },
  });
  assert.equal(summary.totals.executed, 6);
  assert.equal(maximumActive, 3);
});
