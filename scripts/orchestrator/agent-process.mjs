#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

export const MAX_AGENT_TIMEOUT_SECONDS = 300;

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

export function openClawCommand() {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      executable: process.env.OPENCLAW_COMMAND || 'openclaw.cmd',
      shell: false,
      windows_verbatim_arguments: true,
    };
  }
  return { file: process.env.OPENCLAW_COMMAND || 'openclaw', executable: process.env.OPENCLAW_COMMAND || 'openclaw', shell: false };
}

function windowsCommandLine(executable, args) {
  // The outer quotes are required by `cmd /c` when the command itself is a
  // quoted path. `windowsVerbatimArguments` keeps cmd.exe from receiving
  // Node's backslash-escaped quotes as literal characters.
  const values = [executable, ...args].map((value) => {
    const text = String(value);
    if (text.includes('"') || /[\r\n]/u.test(text)) throw new Error('OpenClaw command arguments cannot contain quotes or newlines');
    return `"${text}"`;
  });
  return `"${values.join(' ')}"`;
}

export function openClawSpawnSpec(args) {
  const command = openClawCommand();
  if (process.platform !== 'win32') return {
    file: command.file,
    args,
    options: { shell: false },
  };
  return {
    file: command.file,
    args: ['/d', '/s', '/c', windowsCommandLine(command.executable, args)],
    options: { shell: false, windowsVerbatimArguments: true },
  };
}

export function terminateProcessTree(pid, { platform = process.platform, run = spawnSync,
  kill = process.kill.bind(process), schedule = setTimeout } = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return { ok: false, reason: 'PID_INVALID' };
  if (platform === 'win32') {
    const result = run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, shell: false, encoding: 'utf8',
    });
    // taskkill returns 128 when the process exited between observation and
    // termination. Treat that race as a successful terminal outcome.
    return { ok: result.status === 0 || result.status === 128, status: result.status, error: result.error?.message ?? null };
  }
  try {
    kill(-Number(pid), 'SIGTERM');
    const force = schedule(() => {
      try { kill(-Number(pid), 'SIGKILL'); } catch { /* process group already exited */ }
    }, 2000);
    force.unref?.();
    return { ok: true, status: null, error: null };
  } catch (error) {
    if (error.code === 'ESRCH') return { ok: true, status: null, error: null };
    return { ok: false, status: null, error: error.message };
  }
}

function writeMarker(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, value);
}

export function runOpenClawProcess({ agentId, sessionId, messagePath, timeoutSeconds = MAX_AGENT_TIMEOUT_SECONDS,
  stdoutPath, stderrPath, statusPath, resultPath } = {}) {
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

  const finish = (value) => {
    if (finished) return;
    finished = true;
    stdout.end();
    stderr.end();
    writeMarker(resultPath, {
      schema_version: 1,
      state: value.state,
      agent_id: agentId,
      session_id: sessionId,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: value.exit_code ?? null,
      signal: value.signal ?? null,
      timed_out: Boolean(value.timed_out ?? timedOut),
      error_code: value.error_code ?? null,
      error_message: value.error_message ?? null,
      stdout_path_abs: stdoutPath,
      stderr_path_abs: stderrPath,
    });
    writeMarker(statusPath, {
      schema_version: 1,
      state: value.state,
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
    finish({ state: 'FAILED', error_code: error.code || 'OPENCLAW_SPAWN_FAILED', error_message: error.message });
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
    finish({ state: 'FAILED', error_code: error.code || 'OPENCLAW_PROCESS_ERROR', error_message: error.message });
  });
  child.once('close', (exitCode, signal) => {
    clearTimeout(timeout);
    finish({
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
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
