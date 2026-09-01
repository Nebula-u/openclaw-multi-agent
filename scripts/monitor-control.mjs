#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMonitorConfig } from '../monitor/config.mjs';

const POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5000;

function controlError(code, port, message) {
  return Object.assign(new Error(message), { code, port });
}

function runCommand(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function positivePids(text) {
  return [...new Set(String(text).match(/\b\d+\b/gu)?.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0) ?? [])];
}

export function findListenerPids({ port, platform = process.platform, run = runCommand } = {}) {
  if (!Number.isInteger(port) || port <= 0) throw new RangeError('port must be a positive integer');
  try {
    if (platform === 'linux') {
      const output = run('ss', ['-H', '-ltnp', `sport = :${port}`]);
      return [...new Set([...String(output).matchAll(/pid=(\d+)/gu)].map((match) => Number(match[1])))];
    }
    if (platform === 'win32') {
      const command = `$ErrorActionPreference = 'Stop'; Get-NetTCPConnection -State Listen -LocalPort ${port} | ForEach-Object { $_.OwningProcess }`;
      return positivePids(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]));
    }
  } catch (error) {
    throw controlError('MONITOR_LOOKUP_FAILED', port, `could not inspect listeners on port ${port}: ${error.message}`);
  }
  throw controlError('MONITOR_PLATFORM_UNSUPPORTED', port, `monitor:stop supports Linux and Windows, not ${platform}`);
}

function processCommandLine(pid, { platform, run }) {
  if (platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(); } catch { return ''; }
  }
  if (platform === 'win32') {
    const command = `$ErrorActionPreference = 'Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`;
    try { return String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])).trim(); } catch { return ''; }
  }
  return '';
}

function isProjectMonitor(commandLine, projectRoot) {
  const command = String(commandLine).replaceAll('\\', '/');
  const absoluteEntry = resolve(projectRoot, 'monitor', 'main.mjs').replaceAll('\\', '/');
  return command.includes(absoluteEntry) || /(?:^|\s|["'])monitor\/main\.mjs(?:\s|["']|$)/u.test(command);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForPortRelease({ port, platform, run, waitFor, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (findListenerPids({ port, platform, run }).length > 0) {
    if (Date.now() >= deadline) throw controlError('MONITOR_STOP_TIMEOUT', port, `Monitor port ${port} is still listening after ${timeoutMs} ms`);
    await waitFor(POLL_INTERVAL_MS);
  }
}

export async function stopMonitor({
  projectRoot = process.cwd(),
  config = null,
  platform = process.platform,
  run = runCommand,
  readCommandLine = null,
  kill = process.kill.bind(process),
  waitFor = delay,
  timeoutMs = STOP_TIMEOUT_MS,
} = {}) {
  const resolvedProjectRoot = resolve(projectRoot);
  const { port } = config ?? loadMonitorConfig({ projectRoot: resolvedProjectRoot });
  const pids = findListenerPids({ port, platform, run });
  if (!pids.length) throw controlError('MONITOR_NOT_RUNNING', port, `no listener found on Monitor port ${port}`);
  const readCommand = readCommandLine ?? ((pid) => processCommandLine(pid, { platform, run }));
  const monitorPids = pids.filter((pid) => isProjectMonitor(readCommand(pid), resolvedProjectRoot));
  if (!monitorPids.length) throw controlError('MONITOR_PORT_OCCUPIED', port, `port ${port} is not owned by this project's Monitor`);
  for (const pid of monitorPids) kill(pid, 'SIGTERM');
  await waitForPortRelease({ port, platform, run, waitFor, timeoutMs });
  return { port, stoppedPids: monitorPids };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== 'stop') throw new Error('usage: monitor-control.mjs stop');
  const result = await stopMonitor();
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'stop', ...result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? 'MONITOR_CONTROL_ERROR', message: error.message, port: error.port ?? null } })}\n`);
    process.exitCode = 1;
  });
}
