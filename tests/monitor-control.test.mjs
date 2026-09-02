import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { findListenerPids, stopMonitor } from '../scripts/monitor-control.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('Linux lookup requests only the configured port and gracefully stops its verified Monitor', async () => {
  const commands = [];
  const signals = [];
  let lookupCount = 0;
  const result = await stopMonitor({
    projectRoot: ROOT,
    config: { port: 4318 },
    platform: 'linux',
    run: (file, args) => {
      commands.push({ file, args });
      lookupCount += 1;
      return lookupCount === 1
        ? 'LISTEN 0 511 127.0.0.1:4318 0.0.0.0:* users:(("node",pid=123,fd=30))'
        : '';
    },
    readCommandLine: () => `node ${resolve(ROOT, 'monitor', 'main.mjs')}`,
    kill: (pid, signal) => signals.push({ pid, signal }),
    waitFor: async () => {},
  });

  assert.deepEqual(result, { port: 4318, stoppedPids: [123] });
  assert.deepEqual(signals, [{ pid: 123, signal: 'SIGTERM' }]);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(({ file, args }) => file === 'ss' && args.includes('sport = :4318')));
});

test('Windows lookup parses listener PIDs returned by PowerShell', () => {
  const pids = findListenerPids({
    port: 4318,
    platform: 'win32',
    run: (file, args) => {
      assert.equal(file, 'powershell.exe');
      assert.match(args.at(-1), /-LocalPort 4318/u);
      return '456\r\n789\r\n';
    },
  });

  assert.deepEqual(pids, [456, 789]);
});

test('refuses to signal a non-Monitor listener on the configured port', async () => {
  await assert.rejects(() => stopMonitor({
    projectRoot: ROOT,
    config: { port: 4318 },
    platform: 'win32',
    run: () => '456',
    readCommandLine: () => 'node unrelated-server.mjs',
    kill: () => assert.fail('a non-Monitor listener must not be signaled'),
  }), (error) => error.code === 'MONITOR_PORT_OCCUPIED' && error.port === 4318);
});

test('reports when the configured Monitor port has no listener', async () => {
  await assert.rejects(() => stopMonitor({
    projectRoot: ROOT,
    config: { port: 4318 },
    platform: 'linux',
    run: () => '',
  }), (error) => error.code === 'MONITOR_NOT_RUNNING' && error.port === 4318);
});
