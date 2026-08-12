import { spawnSync } from 'node:child_process';

export function openClawCommand() {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      executable: process.env.OPENCLAW_COMMAND || 'openclaw.cmd',
      shell: false,
      windows_verbatim_arguments: true,
    };
  }
  return {
    file: process.env.OPENCLAW_COMMAND || 'openclaw',
    executable: process.env.OPENCLAW_COMMAND || 'openclaw',
    shell: false,
  };
}

function windowsCommandLine(executable, args) {
  const values = [executable, ...args].map((value) => {
    const text = String(value);
    if (text.includes('"') || /[\r\n]/u.test(text)) {
      throw new Error('OpenClaw command arguments cannot contain quotes or newlines');
    }
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
