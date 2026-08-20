/**
 * Control Kernel 测试夹具
 *
 * 提供：
 *  - kernelUrl()               —— 解析 OPENCLAW_PG_URL（process.env 或项目根 .env）
 *  - requireKernel(t)          —— 无 PG 时 skip 当前测试；有则返回 URL
 *  - skipReason()              —— 供 describe({ skip }) 整体跳过
 *  - tempSchemaName()          —— 生成唯一临时 schema 名 kernel_t_<12hex>
 *  - schemaSqlWith(name)       —— 读 schema.sql 并把两个占位符替换为给定 schema
 *  - createTestPool(url)       —— 建立小连接池
 *  - dropSchema(pool, name)    —— DROP SCHEMA ... CASCADE
 */

import { randomUUID } from 'node:crypto';
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

function projectRoot() {
  return resolve(process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
}

// ─── 导出接口 ─────────────────────────────────────────────────────────────────

export function kernelUrl() {
  return process.env.OPENCLAW_PG_URL
    ?? readEnvironmentFile(join(projectRoot(), '.env')).OPENCLAW_PG_URL
    ?? null;
}

export function requireKernel(t) {
  const url = kernelUrl();
  if (!url) {
    t.skip('OPENCLAW_PG_URL not set; kernel tests skipped');
    return null;
  }
  return url;
}

/** describe({ skip: skipReason() }) —— 无 PG 时返回原因字符串，有则 false */
export function skipReason() {
  return kernelUrl() ? false : 'OPENCLAW_PG_URL not set; kernel tests skipped';
}

export function tempSchemaName(prefix = 'kernel_t') {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 读取 scripts/control-kernel/schema.sql，把 __KERNEL_SCHEMA__ 与
 * __LANGGRAPH_SCHEMA__ 全部替换为 schemaName（测试内两者共用一个隔离 schema）。
 */
export function schemaSqlWith(schemaName) {
  const path = resolve(projectRoot(), 'scripts', 'control-kernel', 'schema.sql');
  return readFileSync(path, 'utf8')
    .replaceAll('__KERNEL_SCHEMA__', schemaName)
    .replaceAll('__LANGGRAPH_SCHEMA__', schemaName);
}

export function createTestPool(url, { max = 4, searchPath = null } = {}) {
  const pool = new Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 5000,
    application_name: 'openclaw-kernel-test',
    ...(searchPath ? { options: `-c search_path=\"${searchPath}\",public` } : {}),
  });
  return pool;
}

export async function dropSchema(pool, schemaName) {
  if (!pool || !schemaName) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}
