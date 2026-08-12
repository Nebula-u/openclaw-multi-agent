import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadMonitorConfig } from '../monitor/config.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('monitor uses a fifteen-minute Agent tool grace while health checks stay responsive', () => {
  const config = loadMonitorConfig({ projectRoot: ROOT, monitorDatabasePath: ':memory:' });
  assert.equal(config.toolRunningGraceSeconds, 900);
  assert.ok(config.heartbeatStaleSeconds <= 300);
  assert.ok(config.possiblyStalledSeconds <= 300);
  assert.ok(config.startingTimeoutSeconds <= 300);
  assert.ok(config.managerWakeTimeoutSeconds <= 300);
});

test('monitor rejects health thresholds above five minutes and Agent tool grace above fifteen minutes', () => {
  for (const override of [
    { heartbeatStaleSeconds: 301 },
    { possiblyStalledSeconds: 301 },
    { startingTimeoutSeconds: 301 },
    { managerWakeTimeoutSeconds: 301 },
  ]) {
    assert.throws(
      () => loadMonitorConfig({ projectRoot: ROOT, monitorDatabasePath: ':memory:', ...override }),
      /must not exceed 300 seconds/u,
    );
  }
  assert.throws(
    () => loadMonitorConfig({ projectRoot: ROOT, monitorDatabasePath: ':memory:', toolRunningGraceSeconds: 901 }),
    /must not exceed 900 seconds/u,
  );
});
