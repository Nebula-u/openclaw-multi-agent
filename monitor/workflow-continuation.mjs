export function createWorkflowContinuation({ runtime, publish, enabled = true, maxTurns = 8 } = {}) {
  let running = false;
  let lastScan = null;
  const statuses = new Map();

  async function scan() {
    if (!enabled || running) return [];
    running = true;
    const results = [];
    try {
      const workflows = await runtime.list();
      for (const workflow of workflows) {
        if (workflow.condition !== 'ACTIVE') continue;
        let turns = 0;
        let result = null;
        while (turns < maxTurns) {
          result = await runtime.run(workflow.workflowId);
          turns += 1;
          if (['WAITING_HUMAN', 'TERMINAL', 'HOLD'].includes(result.condition)) break;
          if (['TASK_RUNNING', 'TASK_DISPATCHED', 'JSON_REPAIR_READY'].includes(result.stop_reason)) break;
        }
        const value = { workflow_id: workflow.workflowId, turns, result, scanned_at: new Date().toISOString() };
        statuses.set(workflow.workflowId, value);
        results.push(value);
        publish?.('continuation', value, { source: 'STATEGRAPH_CONTINUATION' });
      }
      lastScan = new Date().toISOString();
      return results;
    } finally { running = false; }
  }

  return { scan, status: () => ({ enabled, running, last_scan: lastScan, workflows: [...statuses.values()] }) };
}
