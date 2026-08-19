import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateGraphRuntime } from '../scripts/stategraph/runtime.mjs';
import { createTestPool, kernelUrl, skipReason } from './helpers/kernel-fixture.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('StateGraph runtime uses shared PostgreSQL checkpointer and Kernel', { skip: skipReason() }, async () => {
  const ddlPool = createTestPool(kernelUrl(), { max: 1 });
  try {
    const template = readFileSync(join(ROOT, 'scripts', 'control-kernel', 'schema.sql'), 'utf8');
    await ddlPool.query(template.replaceAll('__KERNEL_SCHEMA__', 'kernel'));
  } finally {
    await ddlPool.end();
  }

  const runtime = createStateGraphRuntime({ projectRoot: ROOT, skipAuthority: true });
  let workflowId;
  try {
    await runtime.ready;
    assert.ok(runtime.pool);
    assert.ok(runtime.kernel);
    assert.equal(runtime.checkpointer.constructor.name, 'KernelPostgresSaver');
    assert.ok(Array.isArray(await runtime.list()));
    workflowId = `WF-PG-RUNTIME-${Date.now()}`;
    await runtime.bootstrap({ workflowId, request: { text: 'PG dual write smoke', project_path_abs: ROOT } });
    const run = await runtime.kernel.getRunByThreadId(workflowId);
    assert.ok(run);
    assert.equal(run.workflowId, workflowId);
    assert.ok((await runtime.kernel.listTasks({ runId: run.runId })).length >= 1);
    const audit = await runtime.audit();
    assert.equal(audit.database, 'LANGGRAPH_CHECKPOINTS');
    assert.ok(audit.kernel_chains.some((chain) => chain.run_id === run.runId && chain.ok));
  } finally {
    await runtime.close();
    if (workflowId) {
      const cleanup = createTestPool(kernelUrl(), { max: 1 });
      try { await cleanup.query('DELETE FROM kernel.runs WHERE langgraph_thread_id = $1', [workflowId]); }
      finally { await cleanup.end(); }
    }
  }
});
