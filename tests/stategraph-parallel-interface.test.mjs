import test from 'node:test';
import assert from 'node:assert/strict';
import { Send } from '@langchain/langgraph';
import { createWorkflowNodes, buildWorkflowGraph, parallelDispatchSends } from '../scripts/stategraph/graph.mjs';

const baseDependencies = (enabled) => ({
  projectRoot: process.cwd(),
  policy: { parallelism: { enabled }, task_agents: {}, gate_checks: {} },
  clock: () => new Date('2026-01-01T00:00:00.000Z'),
  sha256: () => 'a'.repeat(64),
});

test('并行占位节点在关闭策略时直通', () => {
  const nodes = createWorkflowNodes(baseDependencies(false));
  assert.deepEqual(nodes.splitTasks({}), { action: 'dispatch' });
  assert.deepEqual(nodes.mergeTasks({}), { action: 'evaluate' });
});

test('并行节点在开启策略时通过条件边返回 LangGraph Send 扇出', () => {
  const nodes = createWorkflowNodes(baseDependencies(true));
  const patch = nodes.splitTasks({ workflowId: 'WF-parallel', revision: 0, events: [], taskGroups: [{ group_id: 'g1', status: 'PENDING_SPLIT', task_ids: ['t1', 't2'], max_parallel: 2 }] });
  assert.equal(patch.stopReason, 'PARALLEL_TASKS_DISPATCHING');
  const sends = parallelDispatchSends({ taskGroups: patch.taskGroups });
  assert.equal(Array.isArray(sends), true);
  assert.equal(sends.length, 2);
  assert.ok(sends[0] instanceof Send);
  assert.equal(sends[0].node, 'dispatch');
  const merged = nodes.mergeTasks({ workflowId: 'WF-parallel', revision: 0, events: [], taskGroups: [{ group_id: 'g1', status: 'READY_TO_MERGE' }] });
  assert.equal(merged.stopReason, 'PARALLEL_TASKS_MERGED');
});

test('并行节点已注册进静态图结构', () => {
  const graph = buildWorkflowGraph(baseDependencies(false), {});
  const nodes = graph.getGraph().nodes;
  assert.ok(nodes.split_tasks);
  assert.ok(nodes.merge_tasks);
});
