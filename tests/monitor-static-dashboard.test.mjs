import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('static dashboard opens without a build step and contains no external runtime dependencies', () => {
  const html = readFileSync(join(ROOT, 'monitor', 'ui', 'index.html'), 'utf8');
  const script = readFileSync(join(ROOT, 'monitor', 'ui', 'app.js'), 'utf8');
  const config = readFileSync(join(ROOT, 'monitor', 'ui', 'config.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'monitor', 'ui', 'styles.css'), 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/u);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/u);
  assert.doesNotMatch(`${html}${script}`, /React|Vite|node_modules/u);
  assert.match(script, /EventSource/u);
  assert.match(script, /api\/client-config/u);
  assert.match(script, /request\('\/api\/agents'\)/u);
  assert.match(script, /sessions\/\$\{encodeURIComponent\(state\.selectedSessionId\)\}\/messages/u);
  assert.match(html, /id="conversation-agent-list"/u);
  assert.match(html, /id="conversation-history"/u);
  assert.doesNotMatch(`${html}${script}`, /api\/supervision|api\/activity|nudge|request-type|api-token/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /\.conversation-stage\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/u);
  assert.match(css, /\.conversation-history\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/u);
  assert.match(css, /\.conversation-console\s*\{[^}]*overflow:\s*hidden;/u);
});

test('dashboard connects directly to the loopback Node monitor backend', () => {
  const html = readFileSync(join(ROOT, 'monitor', 'ui', 'index.html'), 'utf8');
  const script = readFileSync(join(ROOT, 'monitor', 'ui', 'app.js'), 'utf8');
  const config = readFileSync(join(ROOT, 'monitor', 'ui', 'config.js'), 'utf8');
  assert.match(config, /window\.location\.protocol === 'file:'/u);
  assert.match(config, /window\.location\.origin/u);
  assert.match(html, /default-src 'self' file:/u);
  assert.match(html, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/u);
  assert.match(html, /script-src 'self' file:/u);
  assert.match(html, /style-src 'self' file:/u);
  assert.match(script, /defaultApiUrl\.startsWith\('\/'\)/u);
});
