import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInstalledOpenClawRoot } from '../scripts/agent-json-harness/gateway-llm-client.mjs';

test('Gateway client resolves an OpenClaw package on non-Windows hosts', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-package-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'gateway-chat-test.js'), '', 'utf8');
  assert.equal(resolveInstalledOpenClawRoot({ platform: 'linux', env: {}, roots: [root] }), root);
});
