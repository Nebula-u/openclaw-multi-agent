import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export function createGraphResultValidator(projectRoot) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(projectRoot, 'contracts', 'workflow-graph-run-result.schema.json'), 'utf8')));
}

export function graphRunResult(state) {
  return {
    schema_version: 1,
    graph_run_id: state.graphRunId,
    workflow_id: state.workflowId,
    status: state.status ?? 'FAILED',
    before_revision: state.beforeRevision ?? null,
    after_revision: state.afterRevision ?? null,
    action: state.action ?? null,
    phase: state.control?.phase ?? null,
    next_phase: state.nextPhase ?? null,
    task_id: state.currentTask?.task_id ?? null,
    stop_reason: state.stopReason ?? null,
    route_kind: state.routeDecision?.kind ?? null,
    route_reason: state.routeDecision?.reason ?? null,
    route_facts: state.routeFacts ?? null,
    errors: state.errors ?? [],
  };
}
