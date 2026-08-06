import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function integer(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer, received: ${value}`);
  return parsed;
}

function readConfig(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadMonitorConfig(overrides = {}) {
  const projectRoot = resolve(overrides.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
  const fileConfig = readConfig(overrides.configPath ?? process.env.MONITOR_CONFIG_PATH);
  const runtimeRoot = resolve(overrides.runtimeRoot ?? process.env.OPENCLAW_RUNTIME_ROOT ?? fileConfig.runtime_root ?? join(projectRoot, 'runtime'));
  const allowedOrigins = overrides.allowedOrigins ?? fileConfig.allowed_origins
    ?? String(process.env.MONITOR_ALLOWED_ORIGINS ?? 'null').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    projectRoot,
    runtimeRoot,
    databasePath: resolve(overrides.databasePath ?? fileConfig.database_path ?? join(runtimeRoot, 'control', 'control.db')),
    host: overrides.host ?? process.env.MONITOR_HOST ?? fileConfig.host ?? '127.0.0.1',
    port: integer(overrides.port ?? process.env.MONITOR_PORT ?? fileConfig.port, 4310),
    token: overrides.token ?? process.env.MONITOR_TOKEN ?? fileConfig.token ?? randomBytes(24).toString('base64url'),
    allowedOrigins,
    reconcileIntervalMs: integer(overrides.reconcileIntervalMs ?? fileConfig.reconcile_interval_ms, 2000),
    sseRetention: integer(overrides.sseRetention ?? fileConfig.sse_retention, 2000),
    requestBodyLimit: integer(overrides.requestBodyLimit ?? fileConfig.request_body_limit, 1024 * 1024),
  };
}

