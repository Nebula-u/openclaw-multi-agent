#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMonitorConfig } from './config.mjs';
import { createMonitorServer } from './server.mjs';

export async function runSupervisor(overrides = {}) {
  const config = loadMonitorConfig(overrides);
  const monitor = createMonitorServer(config);
  const address = await monitor.start();
  process.stdout.write(`${JSON.stringify({ ok: true, service: 'supervisor-core', host: address.address, port: address.port,
    dashboard: resolve(config.projectRoot, 'monitor', 'ui', 'index.html') })}\n`);
  const shutdown = async () => { await monitor.close(); process.exitCode = 0; };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return monitor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSupervisor().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
