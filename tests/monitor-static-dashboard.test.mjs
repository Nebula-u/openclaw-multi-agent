import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('local dashboard opens without a build step and contains no external runtime dependencies', () => {
  const html = readFileSync(join(ROOT, 'monitor', 'ui', 'index.html'), 'utf8');
  const script = readFileSync(join(ROOT, 'monitor', 'ui', 'app.js'), 'utf8');
  const config = readFileSync(join(ROOT, 'monitor', 'ui', 'config.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'monitor', 'ui', 'styles.css'), 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/u);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/u);
  assert.doesNotMatch(`${html}${script}`, /React|Vite|node_modules/u);
  assert.match(script, /EventSource/u);
  assert.match(script, /renderKey === state\.workflowListKey/u);
  assert.match(script, /renderKey === state\.dialogueKey/u);
  assert.match(script, /api\/workflows\/stream/u);
  assert.match(script, /api\/client-config/u);
  assert.match(script, /method:\s*'POST'/u);
  assert.match(html, /id="run-workflow"/u);
  assert.match(html, /id="theme-toggle"/u);
  assert.doesNotMatch(`${html}${script}`, /api-token|human-approval\.capability|runtime\.capability/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /\[data-theme="dark"\]/u);
  assert.match(html, /只读监测/u);
});

test('dashboard connects directly to the loopback Node monitor backend', () => {
  const html = readFileSync(join(ROOT, 'monitor', 'ui', 'index.html'), 'utf8');
  const script = readFileSync(join(ROOT, 'monitor', 'ui', 'app.js'), 'utf8');
  const config = readFileSync(join(ROOT, 'monitor', 'ui', 'config.js'), 'utf8');
  assert.match(config, /window\.location\.protocol === 'file:'/u);
  assert.match(config, /window\.location\.origin/u);
  assert.match(html, /default-src 'self'/u);
  assert.match(html, /connect-src 'self' http:\/\/127\.0\.0\.1:\*/u);
  assert.match(html, /script-src 'self'/u);
  assert.match(html, /style-src 'self'/u);
  assert.match(script, /window\.location\.protocol !== 'file:'/u);
});
