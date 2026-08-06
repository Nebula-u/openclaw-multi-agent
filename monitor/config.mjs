import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function integer(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer, received: ${value}`);
  return parsed;
}

function boolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error(`expected boolean, received: ${value}`);
}

function readConfig(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expandEnvironment(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_, name) => process.env[name] ?? `%${name}%`)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name) => process.env[name] ?? `\${${name}}`);
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
    monitorDatabasePath: overrides.monitorDatabasePath === ':memory:' ? ':memory:'
      : resolve(expandEnvironment(overrides.monitorDatabasePath ?? fileConfig.monitor_database_path ?? join(runtimeRoot, 'monitor', 'monitor.db'))),
    sessionRoot: resolve(expandEnvironment(overrides.sessionRoot ?? process.env.OPENCLAW_SESSION_ROOT ?? fileConfig.session_root
      ?? join(process.env.USERPROFILE ?? process.env.HOME ?? projectRoot, '.openclaw', 'agents'))),
    host: overrides.host ?? process.env.MONITOR_HOST ?? fileConfig.host ?? '127.0.0.1',
    port: integer(overrides.port ?? process.env.MONITOR_PORT ?? fileConfig.port, 4310),
    token: overrides.token ?? process.env.MONITOR_TOKEN ?? fileConfig.token ?? randomBytes(24).toString('base64url'),
    allowedOrigins,
    reconcileIntervalMs: integer(overrides.reconcileIntervalMs ?? fileConfig.reconcile_interval_ms, 2000),
    sseRetention: integer(overrides.sseRetention ?? fileConfig.sse_retention, 2000),
    requestBodyLimit: integer(overrides.requestBodyLimit ?? fileConfig.request_body_limit, 1024 * 1024),
    watchdogEnabled: boolean(overrides.watchdogEnabled ?? fileConfig.watchdog_enabled, true),
    watchdogShadowMode: boolean(overrides.watchdogShadowMode ?? fileConfig.watchdog_shadow_mode, true),
    heartbeatStaleSeconds: integer(overrides.heartbeatStaleSeconds ?? fileConfig.heartbeat_stale_seconds, 180),
    possiblyStalledSeconds: integer(overrides.possiblyStalledSeconds ?? fileConfig.possibly_stalled_seconds, 300),
    startingTimeoutSeconds: integer(overrides.startingTimeoutSeconds ?? fileConfig.starting_timeout_seconds, 120),
    toolRunningGraceSeconds: integer(overrides.toolRunningGraceSeconds ?? fileConfig.tool_running_grace_seconds, 900),
    supervisionCooldownSeconds: integer(overrides.supervisionCooldownSeconds ?? fileConfig.supervision_cooldown_seconds, 300),
  };
}
