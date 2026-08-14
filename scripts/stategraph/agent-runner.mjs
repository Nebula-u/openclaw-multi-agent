#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { openClawSpawnSpec, terminateProcessTree } from './process-utils.mjs';
import { cleanupTestSandboxSession, verifySandboxRuntime } from './sandbox-runtime.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`missing --${name}`);
  return resolve(options[name]);
}

function appendRawLog(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export function runAgentProcess({ agentId, sessionId, messagePath, timeoutSeconds, stdoutPath, stderrPath,
  statusPath, resultPath, rawLogPath, dispatchId, cycle, sandboxLeasePath = null } = {}) {
  const timeout = Number(timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 900) throw new Error('timeoutSeconds must be between 1 and 900');
  const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message-file', messagePath,
    '--thinking', 'off', '--verbose', 'off', '--timeout', String(timeout), '--json'];
  const command = openClawSpawnSpec(args);
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const stdout = createWriteStream(stdoutPath, { flags: 'w', encoding: 'utf8' });
  const stderr = createWriteStream(stderrPath, { flags: 'w', encoding: 'utf8' });
  const startedAt = new Date().toISOString();
  let child;
  let finished = false;
  let timedOut = false;

  const finish = async (value) => {
    if (finished) return;
    finished = true;
    stdout.end();
    stderr.end();
    let sandboxAttestation = null;
    let sandboxError = null;
    if (sandboxLeasePath) {
      try {
        const lease = JSON.parse(readFileSync(sandboxLeasePath, 'utf8'));
        if (value.state === 'SUCCEEDED') sandboxAttestation = await verifySandboxRuntime({ lease });
        await cleanupTestSandboxSession({ lease, leasePath: sandboxLeasePath });
      } catch (error) { sandboxError = error; }
    }
    const finalValue = sandboxError ? {
      ...value, state: 'FAILED', error_code: sandboxError.code ?? 'SANDBOX_FINALIZATION_FAILED', error_message: sandboxError.message,
    } : value;
    const finishedAt = new Date().toISOString();
    const result = {
      schema_version: 1,
      dispatch_id: dispatchId,
      cycle,
      state: finalValue.state,
      agent_id: agentId,
      session_id: sessionId,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: finalValue.exit_code ?? null,
      signal: finalValue.signal ?? null,
      timed_out: Boolean(finalValue.timed_out ?? timedOut),
      error_code: finalValue.error_code ?? null,
      error_message: finalValue.error_message ?? null,
      sandbox_attestation: sandboxAttestation,
      stdout_path_abs: stdoutPath,
      stderr_path_abs: stderrPath,
    };
    atomicWriteJson(resultPath, result);
    atomicWriteJson(statusPath, { schema_version: 1, dispatch_id: dispatchId, state: result.state, pid: child?.pid ?? null, updated_at: finishedAt });
    appendRawLog(rawLogPath, { recorded_at: finishedAt, stream: 'PROCESS_RESULT', ...result });
  };

  atomicWriteJson(statusPath, { schema_version: 1, dispatch_id: dispatchId, state: 'STARTING', pid: null, updated_at: startedAt });
  appendRawLog(rawLogPath, { recorded_at: startedAt, stream: 'DISPATCH', dispatch_id: dispatchId, cycle, agent_id: agentId, session_id: sessionId });
  try {
    child = spawn(command.file, command.args, { ...command.options, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    void finish({ state: 'FAILED', error_code: error.code ?? 'OPENCLAW_SPAWN_FAILED', error_message: error.message });
    return;
  }
  const timer = setTimeout(() => {
    timedOut = true;
    const terminated = terminateProcessTree(child.pid);
    if (!terminated.ok) child.kill('SIGKILL');
  }, timeout * 1000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => appendRawLog(rawLogPath, { recorded_at: new Date().toISOString(), stream: 'STDOUT', dispatch_id: dispatchId, cycle, content: chunk }));
  child.stderr.on('data', (chunk) => appendRawLog(rawLogPath, { recorded_at: new Date().toISOString(), stream: 'STDERR', dispatch_id: dispatchId, cycle, content: chunk }));
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once('spawn', () => atomicWriteJson(statusPath, { schema_version: 1, dispatch_id: dispatchId, state: 'RUNNING', pid: child.pid, updated_at: new Date().toISOString() }));
  child.once('error', (error) => {
    clearTimeout(timer);
    void finish({ state: 'FAILED', error_code: error.code ?? 'OPENCLAW_PROCESS_ERROR', error_message: error.message });
  });
  child.once('close', (exitCode, signal) => {
    clearTimeout(timer);
    void finish({
      state: exitCode === 0 && !signal && !timedOut ? 'SUCCEEDED' : 'FAILED',
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      error_code: timedOut ? 'OPENCLAW_AGENT_TIMEOUT' : exitCode === 0 ? null : 'OPENCLAW_AGENT_EXIT_NONZERO',
      error_message: timedOut ? `Agent exceeded ${timeout}s` : null,
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  runAgentProcess({
    agentId: options['agent-id'],
    sessionId: options['session-id'],
    messagePath: required(options, 'message-path'),
    timeoutSeconds: Number(options['timeout-seconds']),
    stdoutPath: required(options, 'stdout-path'),
    stderrPath: required(options, 'stderr-path'),
    statusPath: required(options, 'status-path'),
    resultPath: required(options, 'result-path'),
    rawLogPath: required(options, 'raw-log-path'),
    dispatchId: options['dispatch-id'],
    cycle: Number(options.cycle),
    sandboxLeasePath: options['sandbox-lease-path'] ? required(options, 'sandbox-lease-path') : null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
