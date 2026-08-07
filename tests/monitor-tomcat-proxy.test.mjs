import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'deploy', 'tomcat-monitor', 'MonitorProxyServlet.java');
const DESCRIPTOR = join(ROOT, 'deploy', 'tomcat-monitor', 'web.xml');
const SERVICE_TEMPLATE = join(ROOT, 'deploy', 'openclaw-monitor.service');

test('Tomcat monitor proxy is GET-only and only targets the loopback Monitor API', () => {
  assert.ok(existsSync(SOURCE), 'Tomcat proxy servlet source must exist');
  const source = readFileSync(SOURCE, 'utf8');
  assert.match(source, /http:\/\/127\.0\.0\.1:4319\/api/u);
  assert.match(source, /protected void doGet\(/u);
  assert.match(source, /protected void doPost\(/u);
  assert.match(source, /protected void doHead\(/u);
  assert.match(source, /SC_METHOD_NOT_ALLOWED/u);
  assert.doesNotMatch(source, /setRequestProperty\("Origin"/u);
});

test('Tomcat deployment artifacts support Servlet 5 and parameterize the service host paths', () => {
  const descriptor = readFileSync(DESCRIPTOR, 'utf8');
  const service = readFileSync(SERVICE_TEMPLATE, 'utf8');
  assert.match(descriptor, /version="5\.0"/u);
  assert.match(service, /User=__RUN_USER__/u);
  assert.match(service, /Group=__RUN_GROUP__/u);
  assert.match(service, /WorkingDirectory=__PROJECT_ROOT__/u);
  assert.match(service, /ExecStart=\/usr\/bin\/env bash __PROJECT_ROOT__\/scripts\/start-monitor\.sh/u);
});
