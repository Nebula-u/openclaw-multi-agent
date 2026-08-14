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

function expandEnvironment(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_, name) => process.env[name] ?? `%${name}%`)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name) => process.env[name] ?? `\${${name}}`);
}

export function loadMonitorConfig(overrides = {}) {
  const projectRoot = resolve(overrides.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
  const localEnvironment = readEnvironmentFile(join(projectRoot, '.env'));
  const environment = (name) => process.env[name] ?? localEnvironment[name];
  const fileConfig = readConfig(overrides.configPath ?? process.env.MONITOR_CONFIG_PATH);
  const runtimeRoot = resolve(overrides.runtimeRoot ?? environment('OPENCLAW_RUNTIME_ROOT') ?? fileConfig.runtime_root ?? join(projectRoot, 'runtime'));
  const allowedOrigins = overrides.allowedOrigins ?? fileConfig.allowed_origins
    ?? String(environment('MONITOR_ALLOWED_ORIGINS') ?? 'null').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    projectRoot,
    runtimeRoot,
    databasePath: resolve(overrides.databasePath ?? fileConfig.database_path ?? join(runtimeRoot, 'stategraph', 'checkpoints.db')),
    monitorDatabasePath: overrides.monitorDatabasePath === ':memory:' ? ':memory:'
      : resolve(expandEnvironment(overrides.monitorDatabasePath ?? fileConfig.monitor_database_path ?? join(runtimeRoot, 'monitor', 'monitor.db'))),
    sessionRoot: resolve(expandEnvironment(overrides.sessionRoot ?? environment('OPENCLAW_SESSION_ROOT') ?? fileConfig.session_root
      ?? join(process.env.USERPROFILE ?? process.env.HOME ?? projectRoot, '.openclaw', 'agents'))),
    host: overrides.host ?? environment('MONITOR_HOST') ?? fileConfig.host ?? '127.0.0.1',
    port: integer(overrides.port ?? environment('MONITOR_PORT') ?? fileConfig.port, 4319),
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
    managerWakeEnabled: boolean(overrides.managerWakeEnabled ?? fileConfig.manager_wake_enabled, false),
    managerSessionKey: overrides.managerSessionKey ?? process.env.MANAGER_SESSION_KEY ?? fileConfig.manager_session_key ?? null,
    managerWakeTimeoutSeconds: integer(overrides.managerWakeTimeoutSeconds ?? fileConfig.manager_wake_timeout_seconds, 60),
    telemetryMaxEvents: integer(overrides.telemetryMaxEvents ?? fileConfig.telemetry_max_events, 100000),
    activityRetentionDays: integer(overrides.activityRetentionDays ?? fileConfig.activity_retention_days, 30),
    maintenanceIntervalMs: integer(overrides.maintenanceIntervalMs ?? fileConfig.maintenance_interval_ms, 3600000),
    workflowContinuationEnabled: boolean(overrides.workflowContinuationEnabled ?? fileConfig.workflow_continuation_enabled, true),
    workflowContinuationMaxTurns: integer(overrides.workflowContinuationMaxTurns ?? fileConfig.workflow_continuation_max_turns, 8),
  };
}
