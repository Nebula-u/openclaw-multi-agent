#!/usr/bin/env node

import { createKernel } from './kernel.mjs';
import { createKernelPool, resolveKernelConfig } from './pool.mjs';

const apply = process.argv.includes('--apply');

async function main() {
  const config = resolveKernelConfig();
  if (!config.url) throw Object.assign(new Error('OPENCLAW_PG_URL is required'), { code: 'KERNEL_PG_URL_MISSING' });
  const pool = createKernelPool(config);
  const kernel = createKernel({ pool, workerId: config.workerId, leaseSeconds: config.leaseSeconds });
  try {
    const { rows } = await pool.query(
      `SELECT run_id, workflow_id, langgraph_thread_id, state, route_plan
       FROM runs
       WHERE state <> 'TERMINAL' AND route_plan IS NULL
       ORDER BY created_at ASC`,
    );
    const candidates = rows.map((row) => ({
      run_id: row.run_id,
      workflow_id: row.workflow_id ?? row.langgraph_thread_id,
      current_state: row.state,
      action: 'HOLD_LEGACY_STATEGRAPH_RUN',
      reason: 'no frozen route_plan is available; recovery would require guessing',
    }));
    if (!apply) {
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: true, candidates }, null, 2)}\n`);
      return;
    }
    for (const candidate of candidates) {
      await pool.query(
        `UPDATE runs SET workflow_id=COALESCE(workflow_id, langgraph_thread_id), state='HOLD',
          status_reason='LEGACY_STATEGRAPH_IMPORT_REQUIRED', updated_at=now()
         WHERE run_id=$1`, [candidate.run_id],
      );
      await kernel.appendEvent({ runId: candidate.run_id, type: 'LEGACY_STATEGRAPH_IMPORT_REQUIRED',
        key: 'migration', change: 'HOLD', detail: candidate });
    }
    process.stdout.write(`${JSON.stringify({ ok: true, dry_run: false, migrated: candidates.length, candidates }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? 'MIGRATION_FAILED', message: error.message } })}\n`);
  process.exitCode = 1;
});
