/**
 * Control Kernel — PostgreSQL 连接池
 *
 * 唯一出口：createKernelPool() + resolveKernelConfig()
 * 读取优先级：process.env > 项目根 .env 文件
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

// ─── .env 解析（复用 monitor/config.mjs 同源逻辑） ──────────────────────────

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
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

// ─── resolveKernelConfig ─────────────────────────────────────────────────────

/**
 * 从 process.env + 项目根 .env 解析 Control Kernel 所需配置。
 * 返回值中所有数值型字段已转为 Number。
 *
 * @param {{ projectRoot?: string }} [opts]
 * @returns {{ url: string|null, max: number, statementTimeoutMs: number,
 *             connectTimeoutMs: number, leaseSeconds: number, workerId: string,
 *             kernelSchema: string }}
 */
export function resolveKernelConfig(opts = {}) {
  const projectRoot = resolve(opts.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
  const localEnv = readEnvironmentFile(join(projectRoot, '.env'));
  const env = (name) => process.env[name] ?? localEnv[name];

  return {
    url: env('OPENCLAW_PG_URL') ?? null,
    max: safeInt(env('OPENCLAW_PG_POOL_MAX'), 8),
    statementTimeoutMs: safeInt(env('OPENCLAW_PG_STATEMENT_TIMEOUT_MS'), 15000),
    connectTimeoutMs: safeInt(env('OPENCLAW_PG_CONNECT_TIMEOUT_MS'), 5000),
    leaseSeconds: safeInt(env('OPENCLAW_KERNEL_LEASE_SECONDS'), 120),
    workerId: env('OPENCLAW_WORKER_ID') ?? `worker-${process.pid}`,
    kernelSchema: safeSchemaName(env('OPENCLAW_KERNEL_SCHEMA'), 'kernel'),
  };
}

// ─── createKernelPool ────────────────────────────────────────────────────────

/**
 * 创建 Control Kernel 的 PostgreSQL 连接池。
 *
 * repository.mjs / lease.mjs / kernel.mjs 的 SQL 一律使用**裸表名**，表的定位
 * 完全依赖连接上的 search_path。因此通过 PostgreSQL 启动参数逐连接设置；
 * 不能用 pool.query('SET search_path ...')，因为单次 SET 只影响随机取到的连接，
 * 也不能依赖 connect 事件中的异步 query（pg 不会等待事件处理器完成）。
 *
 * @param {{ url?: string, max?: number, statementTimeoutMs?: number,
 *           connectTimeoutMs?: number, kernelSchema?: string }} [opts]
 * @returns {import('pg').Pool}
 */
export function createKernelPool({ url, max = 8, statementTimeoutMs = 15000,
  connectTimeoutMs = 5000, kernelSchema = 'kernel' } = {}) {
  if (!url) {
    throw Object.assign(new Error('OPENCLAW_PG_URL is required'), {
      code: 'KERNEL_PG_URL_MISSING',
    });
  }
  const schema = safeSchemaName(kernelSchema, 'kernel');
  const pool = new Pool({
    connectionString: url,
    max,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 30000,
    application_name: 'openclaw-control-kernel',
    options: `-c search_path=\"${schema}\",public`,
  });
  return pool;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * schema 名会被直接插入 SET search_path 语句（标识符无法参数化），
 * 因此只接受 PostgreSQL 合法标识符字符集，杜绝注入。
 */
function safeSchemaName(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const name = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(name)) {
    throw Object.assign(new Error(`invalid kernel schema name: ${name}`), {
      code: 'KERNEL_SCHEMA_INVALID',
    });
  }
  return name;
}
