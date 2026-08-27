import assert from 'node:assert/strict';
import test from 'node:test';
import * as runner from '../scripts/orchestrator/openclaw-runner.mjs';
import * as service from '../scripts/orchestrator/service.mjs';

const { buildOpenClawAgentArgs, extractFinalAssistantText } = runner;

test('worker launch inherits configured thinking so HR can review persisted reasoning', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'developer-agent', sessionId: 'session-one', messagePath: 'F:/message.md' });
  assert.equal(args.includes('--thinking'), false);
});

test('TEST task messages use staged sandbox paths without host command paths', () => {
  const message = service.taskMessage({
    workflowId: 'WF-stage', taskId: 'TASK-stage', runId: 'RUN-stage', stepId: 'test', agentId: 'test-agent', attempt: 1,
    worktreePathAbs: '/host/runtime/worktrees/task/repo', artifactRootAbs: '/host/runtime/artifacts/task', contextManifestPathAbs: '/host/runtime/artifacts/task/input/context-manifest.json',
    contextManifestSha256: 'a'.repeat(64), rawOutputPath: '/host/runtime/artifacts/task/.agent-raw/result.json.raw',
    testSandbox: {
      executionWorktreeAbs: '/workspace/.task-sandbox/repo',
      executionInputRootAbs: '/workspace/.task-sandbox/input',
      executionContextManifestPathAbs: '/workspace/.task-sandbox/input/execution-context-manifest.json',
      executionRawOutputPath: '/workspace/.task-sandbox/output/result.json.raw',
    },
  });
  assert.match(message, /execution_worktree_path_abs: \/workspace\/.task-sandbox\/repo/u);
  assert.match(message, /execution_context_manifest_path_abs: \/workspace\/.task-sandbox\/input\/execution-context-manifest\.json/u);
  assert.match(message, /\/workspace\/.task-sandbox\/output\/result\.json\.raw/u);
  assert.doesNotMatch(message, /\/host\/runtime\//u);
});

test('TEST task messages reject a dispatch that has no prepared sandbox staging', () => {
  assert.throws(() => service.taskMessage({
    kind: 'TEST', workflowId: 'WF-stage', taskId: 'TASK-stage', runId: 'RUN-stage', stepId: 'test', agentId: 'test-agent', attempt: 1,
    worktreePathAbs: 'F:/runtime/worktrees/task/repo', artifactRootAbs: 'F:/runtime/artifacts/task',
    contextManifestPathAbs: 'F:/runtime/artifacts/task/input/context-manifest.json', contextManifestSha256: 'a'.repeat(64),
    rawOutputPath: 'F:/runtime/artifacts/task/.agent-raw/result.json.raw',
  }), (error) => error.code === 'TEST_SANDBOX_STAGING_REQUIRED');
});

test('HR launch can explicitly disable its own thinking output', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'hr-agent', sessionId: 'hr-one', messagePath: 'F:/message.md', thinking: 'off' });
  assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', 'off']);
});

test('JSON repair reads the final assistant payload from OpenClaw JSON stdout', () => {
  const text = '{"schema_version":1}';
  assert.equal(extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { payloads: [{ text }], finalAssistantVisibleText: text } })), text);
  assert.equal(extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { finalAssistantVisibleText: ` \n${text}\n ` } })), text);
  assert.throws(() => extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { payloads: [] } })),
    (error) => error.code === 'OPENCLAW_REPAIR_OUTPUT_MISSING');
});

test('JSON repair bridge rejects wrappers, fences, arrays and multiple values', () => {
  for (const text of [
    '修复结果如下：\n{"schema_version":1}',
    '```json\n{"schema_version":1}\n```',
    '[{"schema_version":1}]',
    '{"schema_version":1}\n{"schema_version":1}',
  ]) {
    assert.throws(() => extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { finalAssistantVisibleText: text } })),
      (error) => error.code === 'OPENCLAW_REPAIR_OUTPUT_INVALID');
  }
});

test('runner classifies an unexpectedly terminated agent process as disappeared', () => {
  assert.equal(typeof runner.classifyOpenClawExit, 'function');
  assert.equal(runner.classifyOpenClawExit({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', cancelled: false }),
    'OPENCLAW_AGENT_DISAPPEARED');
  assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: '', stderr: '', cancelled: false }),
    'OPENCLAW_AGENT_DISAPPEARED');
  assert.equal(runner.classifyOpenClawExit({ exitCode: 2, signal: null, stdout: '', stderr: '', cancelled: false }), null);
});

test('runner distinguishes a reported Gateway connection loss from other nonzero exits', () => {
  assert.equal(typeof runner.classifyOpenClawExit, 'function');
  for (const stderr of [
    'Gateway connection closed unexpectedly',
    'gateway not connected',
    'Gateway socket closed',
    'Gateway websocket closed',
    'Gateway request failed: connect ECONNREFUSED 127.0.0.1',
  ]) {
    assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: '', stderr, cancelled: false }),
      'OPENCLAW_GATEWAY_UNAVAILABLE', stderr);
  }
  assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: '', stderr: 'request validation failed', cancelled: false }), null);
  assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: '', stderr: 'database connection closed', cancelled: false }), null);
  assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: '', stderr: 'Redis ECONNREFUSED', cancelled: false }), null);
  assert.equal(runner.classifyOpenClawExit({ exitCode: 1, signal: null, stdout: 'Gateway connection closed unexpectedly', stderr: 'request validation failed', cancelled: false }), null);
  assert.equal(runner.classifyOpenClawExit({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', cancelled: true }),
    'ORCHESTRATOR_SHUTDOWN');
});

test('orchestrator preserves the runner disappearance code and signal', () => {
  assert.equal(typeof service.openClawAgentExitError, 'function');
  const error = service.openClawAgentExitError({
    exitCode: -1,
    signal: 'SIGTERM',
    stderr: '',
    failureCode: 'OPENCLAW_AGENT_DISAPPEARED',
  });
  assert.equal(error.code, 'OPENCLAW_AGENT_DISAPPEARED');
  assert.deepEqual(error.details, { signal: 'SIGTERM', stderr: '' });
});
