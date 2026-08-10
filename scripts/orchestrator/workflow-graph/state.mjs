import { Annotation } from '@langchain/langgraph';

const replace = { reducer: (_current, next) => next, default: () => null };

export const WorkflowGraphState = Annotation.Root({
  workflowId: Annotation(replace),
  graphRunId: Annotation(replace),
  requestedTargetPhase: Annotation(replace),
  control: Annotation(replace),
  snapshot: Annotation(replace),
  audit: Annotation(replace),
  phaseSpec: Annotation(replace),
  currentTask: Annotation(replace),
  taskResult: Annotation(replace),
  route: Annotation({ reducer: (_current, next) => next, default: () => 'load' }),
  status: Annotation(replace),
  action: Annotation(replace),
  nextPhase: Annotation(replace),
  command: Annotation(replace),
  routeFacts: Annotation(replace),
  routeDecision: Annotation(replace),
  stopReason: Annotation(replace),
  beforeRevision: Annotation(replace),
  afterRevision: Annotation(replace),
  errors: Annotation({ reducer: (current, next) => [...current, ...next], default: () => [] }),
});
