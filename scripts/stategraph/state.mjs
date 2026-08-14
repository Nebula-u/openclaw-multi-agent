import { Annotation } from '@langchain/langgraph';

const replace = (defaultValue = null) => Annotation({
  reducer: (_current, next) => next,
  default: () => structuredClone(defaultValue),
});

export const WorkflowState = Annotation.Root({
  schemaVersion: replace(1),
  workflowId: replace(),
  request: replace(),
  targetProjectRootAbs: replace(),
  baseCommit: replace(),
  candidateCommit: replace(),
  candidateHistory: replace([]),
  createdAt: replace(),
  updatedAt: replace(),
  revision: replace(0),
  phase: replace('BOOTSTRAP'),
  condition: replace('ACTIVE'),
  outcome: replace(),
  statusReason: replace(),
  routePlan: replace(),
  approvalPlan: replace([]),
  pendingApproval: replace(),
  steps: replace([]),
  currentStepIndex: replace(0),
  tasks: replace([]),
  activeTaskId: replace(),
  operatorCommand: replace(),
  events: replace([]),
  managerReports: replace([]),
  action: replace('decide'),
  lastAction: replace(),
  stopReason: replace(),
});
