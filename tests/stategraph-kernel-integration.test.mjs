import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createStateGraphRuntime } from '../scripts/stategraph/runtime.mjs';
import { createTestPool, kernelUrl, schemaSqlWith, skipReason } from './helpers/kernel-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('StateGraph facts are projected into Kernel runs/tasks and Monitor fields', { skip: skipReason() }, async (t) => {
  const ddl = createTestPool(kernelUrl(), { max: 1 });
  await ddl.query(schemaSqlWith('kernel'));
  await ddl.end();
  const workflowId = `WF-KERNEL-INTEGRATION-${Date.now()}`;
  const runtime = createStateGraphRuntime({ projectRoot: ROOT, skipAuthority: true,
    dispatcher: { start: (task) => task, reconcile: (task) => ({ kind: 'WAITING', task }) } });
  t.after(async () => {
    await runtime.close();
    const cleanup = createTestPool(kernelUrl(), { max: 1 });
    await cleanup.query('DELETE FROM kernel.runs WHERE langgraph_thread_id = $1', [workflowId]);
    await cleanup.end();
  });
  await runtime.ready;
  await runtime.bootstrap({ workflowId, request: { text: 'kernel integration', project_path_abs: ROOT } });
  const run = await runtime.kernel.getRunByThreadId(workflowId);
  assert.ok(run);
  const projection = await runtime.kernel.projectRuns({ limit: 20 });
  const projected = projection.find((item) => item.langgraph_thread_id === workflowId);
  assert.ok(projected);
  assert.equal(projected.run_id, run.runId);
  assert.ok(projected.tasks.length >= 1);
  assert.equal(typeof projected.executions, 'object');
  assert.equal(typeof projected.artifacts, 'object');
});
