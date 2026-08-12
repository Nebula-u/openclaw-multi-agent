import { END, START, StateGraph } from '@langchain/langgraph';
import { createGraphNodes } from './nodes.mjs';
import { WorkflowGraphState } from './state.mjs';

export function buildWorkflowGraph(dependencies, { checkpointer = undefined } = {}) {
  const nodes = createGraphNodes(dependencies);
  return new StateGraph(WorkflowGraphState)
    .addNode('load_control_state', nodes.loadControlState)
    .addNode('classify_control', nodes.classifyControl)
    .addNode('route_phase', nodes.routePhase)
    .addNode('handle_intake', nodes.handleIntake)
    .addNode('handle_task', nodes.handleTask)
    .addNode('evaluate_task', nodes.evaluateTask)
    .addNode('handle_gate', nodes.handleGate)
    .addNode('handle_final', nodes.handleFinal)
    .addNode('apply_transition', nodes.applyTransition)
    .addNode('finish', nodes.finish)
    .addEdge(START, 'load_control_state')
    .addEdge('load_control_state', 'classify_control')
    .addConditionalEdges('classify_control', (state) => state.route, { phase: 'route_phase', finish: 'finish' })
    .addConditionalEdges('route_phase', (state) => state.route, {
      intake: 'handle_intake', task: 'handle_task', gate: 'handle_gate', final: 'handle_final',
    })
    .addConditionalEdges('handle_intake', (state) => state.route, { apply: 'apply_transition', finish: 'finish' })
    .addConditionalEdges('handle_task', (state) => state.route, { evaluate: 'evaluate_task', finish: 'finish', apply: 'apply_transition' })
    .addConditionalEdges('evaluate_task', (state) => state.route, { apply: 'apply_transition', finish: 'finish' })
    .addConditionalEdges('handle_gate', (state) => state.route, { apply: 'apply_transition', finish: 'finish' })
    .addConditionalEdges('handle_final', (state) => state.route, { apply: 'apply_transition', finish: 'finish' })
    .addEdge('apply_transition', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}
