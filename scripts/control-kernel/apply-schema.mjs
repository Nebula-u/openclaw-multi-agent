#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openKernelDatabase, resolveKernelConfig } from './database.mjs';

export function applyKernelSchema(options = {}) {
  const config = resolveKernelConfig(options);
  const database = openKernelDatabase(config);
  database.close();
  return { databasePath: config.databasePath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = applyKernelSchema();
    process.stdout.write(`[control-kernel] SQLite schema ready at ${result.databasePath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
