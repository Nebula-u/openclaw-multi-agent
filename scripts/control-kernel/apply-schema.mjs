/**
 * Control Kernel — 数据库结构应用 CLI
 *
 * 用法：node scripts/control-kernel/apply-schema.mjs [schema.sql 路径]
 *
 * 读取 scripts/control-kernel/schema.sql，替换 __KERNEL_SCHEMA__ /
 * __LANGGRAPH_SCHEMA__ 占位符后在目标库上幂等应用（全部 IF NOT EXISTS）。
 * 关闭时自动 end() 释放连接池。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createKernelPool, resolveKernelConfig } from './pool.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = resolveKernelConfig();
  if (!config.url) {
    throw Object.assign(new Error(
      'OPENCLAW_PG_URL 未配置（process.env 或项目根 .env）；已跳过应用 schema',
    ), { code: 'KERNEL_PG_URL_MISSING' });
  }

  const schemaPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(here, 'schema.sql');

  const template = readFileSync(schemaPath, 'utf8');
  const sql = template.replaceAll('__KERNEL_SCHEMA__', config.kernelSchema);

  // 建表阶段 schema 可能尚不存在，search_path 指向它会失败；这里显式让
  // createKernelPool 回落到 public，DDL 内的对象名已被占位符替换为全限定名。
  const pool = createKernelPool({ url: config.url, kernelSchema: 'public' });
  try {
    await pool.query(sql);
    console.log(`[control-kernel] schema applied from ${schemaPath} (kernel=${config.kernelSchema})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? String(err));
  process.exit(1);
});
