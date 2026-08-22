import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectKernelSchema, migrateKernelSchema } from './migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, 'schema.sql'), 'utf8');

function readEnvironmentFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveKernelConfig(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
  const local = readEnvironmentFile(join(projectRoot, '.env'));
  const env = (name) => process.env[name] ?? local[name];
  const configuredPath = options.databasePath ?? env('OPENCLAW_KERNEL_DB_PATH');
  const databasePath = configuredPath === ':memory:' ? ':memory:' : resolve(projectRoot, configuredPath ?? join('runtime', 'control', 'kernel.db'));
  if (databasePath !== ':memory:' && (/^[\\/]{2}/u.test(String(configuredPath ?? '')) || /^[\\/]{2}/u.test(databasePath))) {
    throw Object.assign(new Error('Control Kernel SQLite must use a local filesystem path'), { code: 'KERNEL_DB_NETWORK_PATH_FORBIDDEN' });
  }
  return {
    projectRoot,
    databasePath,
    busyTimeoutMs: positiveInteger(options.busyTimeoutMs ?? env('OPENCLAW_KERNEL_BUSY_TIMEOUT_MS'), 5000),
    leaseSeconds: positiveInteger(options.leaseSeconds ?? env('OPENCLAW_KERNEL_LEASE_SECONDS'), 120),
    workerId: options.workerId ?? env('OPENCLAW_WORKER_ID') ?? `worker-${process.pid}`,
  };
}

function params(values) { return Array.isArray(values) ? values : []; }

function createFacade(sqlite, databasePath) {
  return {
    path: databasePath,
    raw: sqlite,
    exec(sql) { sqlite.exec(sql); },
    run(sql, values = []) { return sqlite.prepare(sql).run(...params(values)); },
    get(sql, values = []) { return sqlite.prepare(sql).get(...params(values)); },
    all(sql, values = []) { return sqlite.prepare(sql).all(...params(values)); },
    transaction(fn, { immediate = true } = {}) {
      sqlite.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        try { sqlite.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw error;
      }
    },
    close() { sqlite.close(); },
  };
}

export function openKernelDatabase({ databasePath, readonly = false, busyTimeoutMs = 5000, initialize = true } = {}) {
  if (!databasePath) throw Object.assign(new Error('OPENCLAW_KERNEL_DB_PATH is required'), { code: 'KERNEL_DB_PATH_MISSING' });
  const resolvedPath = databasePath === ':memory:' ? ':memory:' : resolve(databasePath);
  if (!readonly && resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });
  const sqlite = new DatabaseSync(resolvedPath, { readOnly: readonly, timeout: busyTimeoutMs });
  sqlite.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${positiveInteger(busyTimeoutMs, 5000)};`);
  if (!readonly) {
    if (resolvedPath !== ':memory:') sqlite.exec('PRAGMA journal_mode=WAL;');
    sqlite.exec('PRAGMA synchronous=FULL;');
    if (initialize) {
      sqlite.exec(schemaSql);
      migrateKernelSchema(sqlite, schemaSql);
    }
  } else {
    sqlite.exec('PRAGMA query_only=ON;');
  }
  return createFacade(sqlite, resolvedPath);
}

export function inspectKernelDatabaseSchema(database) {
  return inspectKernelSchema(database.raw, schemaSql);
}
