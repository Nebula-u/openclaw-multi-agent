#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKernel } from './control-kernel/kernel.mjs';
import { createKernelPool, resolveKernelConfig } from './control-kernel/pool.mjs';
import { createWorkflowRepository } from './control-kernel/workflow-repository.mjs';
import { createHrService } from './hr/service.mjs';

export async function main() {
  const projectRoot = resolve(process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd()); const config = resolveKernelConfig({ projectRoot });
  const pool = createKernelPool({ ...config }); const kernel = createKernel({ pool, workerId: `${config.workerId}-hr`, leaseSeconds: config.leaseSeconds });
  const repository = createWorkflowRepository({ pool, kernel }); const hr = createHrService({ projectRoot, repository, kernel });
  try { process.stdout.write(`${JSON.stringify({ ok: true, jobs: await hr.runPending() }, null, 2)}\n`); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
