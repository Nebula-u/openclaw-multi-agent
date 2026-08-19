import { Annotation } from '@langchain/langgraph';
import { canonicalJson, sha256 } from './events.mjs';

const replace = (defaultValue = null) => Annotation({
  reducer: (_current, next) => next,
  default: () => structuredClone(defaultValue),
});
const append = (defaultValue = []) => Annotation({
  reducer: (current, next) => {
    const before = current ?? defaultValue;
    const incoming = Array.isArray(next) ? next : [next];
    if (incoming.length >= before.length && before.every((item, index) => JSON.stringify(item) === JSON.stringify(incoming[index]))) return incoming;
    const values = [...before];
    for (const item of incoming) if (!values.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) values.push(item);
    return values;
  },
  default: () => structuredClone(defaultValue),
});
const mergeById = (id, defaultValue = []) => Annotation({
  reducer: (current, next) => {
    const merged = new Map((current ?? defaultValue).map((item) => [item?.[id], item]));
    for (const item of (Array.isArray(next) ? next : [next])) merged.set(item?.[id], item);
    return [...merged.values()];
  },
  default: () => structuredClone(defaultValue),
});
const mergeEvents = (defaultValue = []) => Annotation({
  reducer: (current, next) => {
    const merged = new Map();
    const identity = (event) => canonicalJson({
      schema_version: event?.schema_version ?? 1,
      workflow_id: event?.workflow_id ?? null,
      type: event?.type ?? null,
      payload: event?.payload ?? {},
      occurred_at: event?.occurred_at ?? null,
    });
    for (const event of [...(current ?? defaultValue), ...(Array.isArray(next) ? next : [next])]) {
      if (event && typeof event === 'object') merged.set(identity(event), event);
    }
    const ordered = [...merged.values()].sort((left, right) => {
      const revision = Number(left.revision ?? 0) - Number(right.revision ?? 0);
      if (revision) return revision;
      return identity(left).localeCompare(identity(right));
    });
    let previous = null;
    return ordered.map((event, index) => {
      const body = {
        schema_version: event.schema_version ?? 1,
        workflow_id: event.workflow_id ?? null,
        revision: index + 1,
        type: event.type,
        payload: event.payload ?? {},
        occurred_at: event.occurred_at ?? null,
        previous_event_hash: previous,
      };
      const eventHash = sha256(body);
      previous = eventHash;
      return { ...body, event_hash: eventHash };
    });
  },
  default: () => structuredClone(defaultValue),
});
const maxNumber = (defaultValue = 0) => Annotation({
  reducer: (current, next) => Math.max(Number(current ?? defaultValue), Number(next ?? defaultValue)),
  default: () => defaultValue,
});

export const WorkflowState = Annotation.Root({
  schemaVersion: replace(1),
  workflowId: replace(),
  request: replace(),
  workflowTitle: replace(),
  targetProjectRootAbs: replace(),
  baseCommit: replace(),
  candidateCommit: replace(),
  candidateHistory: append([]),
  createdAt: replace(),
  updatedAt: replace(),
  revision: maxNumber(0),
  phase: replace('BOOTSTRAP'),
  condition: replace('ACTIVE'),
  outcome: replace(),
  statusReason: replace(),
  routePlan: replace(),
  routeHistory: append([]),
  confirmedRoutePlan: replace(),
  approvalPlan: replace([]),
  pendingApproval: replace(),
  steps: replace([]),
  currentStepIndex: replace(0),
  tasks: mergeById('task_id', []),
  taskGroups: mergeById('group_id', []),
  parallelism: replace({ enabled: false, max_parallel: 1 }),
  activeTaskId: replace(),
  operatorCommand: replace(),
  routeChangeCommand: replace(),
  events: mergeEvents([]),
  managerReports: append([]),
  action: replace('decide'),
  lastAction: replace(),
  stopReason: replace(),
});
