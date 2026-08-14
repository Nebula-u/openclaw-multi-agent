#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorityPaths, initializeAuthority } from './stategraph/authority.mjs';
import { createWorkflowIntakeServer } from './stategraph/intake-server.mjs';
import { createStateGraphRuntime } from './stategraph/runtime.mjs';

function positive(value, fallback) { const parsed = Number.parseInt(value ?? '', 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
export async function runIntakeController({ projectRoot = process.cwd(), host = process.env.OPENCLAW_INTAKE_HOST ?? '127.0.0.1', port = positive(process.env.OPENCLAW_INTAKE_PORT, 4320) } = {}) {
  const root = resolve(projectRoot); initializeAuthority(root); const paths = authorityPaths(root);
  process.env.OPENCLAW_STATEGRAPH_CAPABILITY = readFileSync(paths.runtime, 'utf8').trim();
  process.env.OPENCLAW_HUMAN_APPROVAL_CAPABILITY = readFileSync(paths.human, 'utf8').trim();
  const runtime = createStateGraphRuntime({ projectRoot: root });
  const controller = createWorkflowIntakeServer({ runtime, projectRoot: root, token: readFileSync(paths.intake, 'utf8').trim(), host, port });
  const address = await controller.start();
  process.stdout.write(`${JSON.stringify({ ok: true, service: 'stategraph-intake', host: address.address, port: address.port })}\n`);
  const stop = async () => { await controller.close(); runtime.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return controller;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runIntakeController().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
