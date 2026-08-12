#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { cleanupTestSandboxSession, verifySandboxRuntime } from './sandbox-runtime.mjs';
import { openClawSpawnSpec, terminateProcessTree } from './process-utils.mjs';

export const MAX_AGENT_TIMEOUT_SECONDS = 900;

export function validateAgentTimeoutSeconds(value) {
  const timeoutSeconds = Number(value);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_AGENT_TIMEOUT_SECONDS) {
    throw new Error(`Agent timeout must be an integer between 1 and ${MAX_AGENT_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutSeconds;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

export { openClawCommand, openClawSpawnSpec, terminateProcessTree } from './process-utils.mjs';

function writeMarker(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, value);
}

export function runOpenClawProcess({ agentId, sessionId, messagePath, timeoutSeconds = MAX_AGENT_TIMEOUT_SECONDS,
  stdoutPath, stderrPath, statusPath, resultPath, sandboxLeasePath = null } = {}) {
  timeoutSeconds = validateAgentTimeoutSeconds(timeoutSeconds);
  const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message-file', messagePath,
    '--thinking', 'off', '--verbose', 'off', '--timeout', String(timeoutSeconds), '--json'];
  const command = openClawSpawnSpec(args);
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const stdout = createWriteStream(stdoutPath, { flags: 'w', encoding: 'utf8' });
  const stderr = createWriteStream(stderrPath, { flags: 'w', encoding: 'utf8' });
  const startedAt = new Date().toISOString();
  let timedOut = false;
  let finished = false;
  let child;

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
      } catch (error) {
        sandboxError = error;
      }
    }
    const finalValue = sandboxError ? {
      ...value, state: 'FAILED', error_code: sandboxError.code ?? 'SANDBOX_FINALIZATION_FAILED',
      error_message: sandboxError.message, timed_out: Boolean(value.timed_out),
    } : value;
    writeMarker(resultPath, {
      schema_version: 1,
      state: finalValue.state,
      agent_id: agentId,
      session_id: sessionId,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: finalValue.exit_code ?? null,
      signal: finalValue.signal ?? null,
      timed_out: Boolean(finalValue.timed_out ?? timedOut),
      error_code: finalValue.error_code ?? null,
      error_message: finalValue.error_message ?? null,
      sandbox_attestation: sandboxAttestation,
      stdout_path_abs: stdoutPath,
      stderr_path_abs: stderrPath,
    });
    writeMarker(statusPath, {
      schema_version: 1,
      state: finalValue.state,
      agent_id: agentId,
      session_id: sessionId,
      pid: child?.pid ?? null,
      updated_at: new Date().toISOString(),
    });
  };

  writeMarker(statusPath, {
    schema_version: 1,
    state: 'STARTING',
    agent_id: agentId,
    session_id: sessionId,
    pid: null,
    updated_at: startedAt,
  });

  try {
    child = spawn(command.file, command.args, {
      ...command.options,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    void finish({ state: 'FAILED', error_code: error.code || 'OPENCLAW_SPAWN_FAILED', error_message: error.message });
    return;
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    const terminated = terminateProcessTree(child.pid);
    if (!terminated.ok) child.kill('SIGKILL');
  }, timeoutSeconds * 1000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once('spawn', () => writeMarker(statusPath, {
    schema_version: 1,
    state: 'RUNNING',
    agent_id: agentId,
    session_id: sessionId,
    pid: child.pid,
    updated_at: new Date().toISOString(),
  }));
  child.once('error', (error) => {
    clearTimeout(timeout);
    void finish({ state: 'FAILED', error_code: error.code || 'OPENCLAW_PROCESS_ERROR', error_message: error.message });
  });
  child.once('close', (exitCode, signal) => {
    clearTimeout(timeout);
    void finish({
      state: exitCode === 0 && !signal && !timedOut ? 'SUCCEEDED' : 'FAILED',
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      error_code: timedOut ? 'OPENCLAW_AGENT_TIMEOUT' : null,
      error_message: timedOut ? `OpenClaw Agent exceeded ${timeoutSeconds}s` : null,
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = (name) => {
    if (!options[name]) throw new Error(`missing required option --${name}`);
    return resolve(options[name]);
  };
  runOpenClawProcess({
    agentId: options['agent-id'],
    sessionId: options['session-id'],
    messagePath: required('message-path'),
    timeoutSeconds: Number(options['timeout-seconds'] ?? MAX_AGENT_TIMEOUT_SECONDS),
    stdoutPath: required('stdout-path'),
    stderrPath: required('stderr-path'),
    statusPath: required('status-path'),
    resultPath: required('result-path'),
    sandboxLeasePath: options['sandbox-lease-path'] ? required('sandbox-lease-path') : null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
