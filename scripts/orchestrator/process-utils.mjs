import { spawnSync } from 'node:child_process';

function windowsCommandLine(executable, args) {
  return `"${[executable, ...args].map((value) => {
    const text = String(value);
    if (text.includes('"') || /[\r\n]/u.test(text)) throw new Error('OpenClaw arguments cannot contain quotes or newlines');
    return `"${text}"`;
  }).join(' ')}"`;
}

export function openClawSpawnSpec(args) {
  const executable = process.env.OPENCLAW_COMMAND || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  if (process.platform !== 'win32') return { file: executable, args, options: { shell: false } };
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', windowsCommandLine(executable, args)],
    options: { shell: false, windowsVerbatimArguments: true },
  };
}

export function terminateProcessTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill.bind(process), schedule = setTimeout } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return { ok: false, reason: 'PID_INVALID' };
  if (platform === 'win32') {
    const result = run('taskkill.exe', ['/PID', String(numericPid), '/T', '/F'], { windowsHide: true, shell: false, encoding: 'utf8' });
    return { ok: result.status === 0 || result.status === 128, status: result.status, error: result.error?.message ?? null };
  }
  try {
    kill(-numericPid, 'SIGTERM');
    const force = schedule(() => { try { kill(-numericPid, 'SIGKILL'); } catch { /* already exited */ } }, 2000);
    force.unref?.();
    return { ok: true, status: null, error: null };
  } catch (error) {
    return error.code === 'ESRCH' ? { ok: true, status: null, error: null } : { ok: false, status: null, error: error.message };
  }
}
