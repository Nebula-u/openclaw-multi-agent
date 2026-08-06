#!/usr/bin/env node

import { resolve } from 'node:path';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';
import { loadMonitorConfig } from './config.mjs';

const config = loadMonitorConfig();
const database = openControlDatabase(config.databasePath);
try {
  createTaskRepository(config.projectRoot, database);
  createSupervisionRepository(config.projectRoot, database);
  const audit = auditControlDatabase(database);
  process.stdout.write(`${JSON.stringify({ ok: audit.ok, service: 'supervisor-core', database: resolve(config.databasePath), audit }, null, 2)}\n`);
  process.exitCode = audit.ok ? 0 : 1;
} finally {
  database.close();
}

