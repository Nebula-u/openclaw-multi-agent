import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

test('static dashboard opens without a build step and contains no external runtime dependencies', () => {
  const html = readFileSync(join(ROOT, 'monitor', 'ui', 'index.html'), 'utf8');
  const script = readFileSync(join(ROOT, 'monitor', 'ui', 'app.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'monitor', 'ui', 'styles.css'), 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/u);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/u);
  assert.doesNotMatch(`${html}${script}`, /React|Vite|node_modules/u);
  assert.match(script, /EventSource/u);
  assert.match(script, /api\/client-config/u);
  assert.match(script, /api\/tasks\/\$\{encodeURIComponent\(task\.task_id\)\}\/activity/u);
  assert.doesNotMatch(`${html}${script}`, /api\/supervision|api\/activity|nudge|request-type|api-token/u);
  assert.match(css, /prefers-reduced-motion/u);
});
