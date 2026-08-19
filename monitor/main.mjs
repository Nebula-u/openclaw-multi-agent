#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMonitorConfig } from './config.mjs';
import { createKernelMonitorServer } from './kernel-server.mjs';

export async function runMonitor(overrides = {}) {
  const config = loadMonitorConfig(overrides);
  const monitor = createKernelMonitorServer(config);
  const address = await monitor.start();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    service: 'orchestrator-monitor',
    backend: 'node',
    host: address.address,
    port: address.port,
    dashboard: `http://${address.address}:${address.port}/`,
  })}\n`);
  const shutdown = async () => { await monitor.close(); process.exitCode = 0; };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return monitor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMonitor().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
