export function createCompactManagerContext(state, policy) {
  const manager = policy.manager;
  const value = {
    schema_version: 1,
    workflow_id: state.workflowId,
    revision: state.revision,
    request: state.request,
    route_plan: state.routePlan ? {
      status: state.routePlan.status,
      route_hash: state.routePlan.route_hash,
      summary: state.routePlan.summary,
      steps: state.routePlan.steps.map(({ step_id, kind, title, status }) => ({ step_id, kind, title, status })),
    } : null,
    active_task: state.tasks?.find((task) => task.task_id === state.activeTaskId) ?? null,
    pending_approval: state.pendingApproval,
    recent_events: (state.events ?? []).slice(-manager.recent_events).map(({ event_hash, previous_event_hash, ...event }) => event),
    recent_error_reports: (state.managerReports ?? []).slice(-manager.recent_error_reports),
  };
  let json = JSON.stringify(value);
  if (json.length > manager.prompt_max_chars) {
    value.recent_events = value.recent_events.slice(-2);
    value.request = { ...value.request, text: String(value.request?.text ?? '').slice(0, 3000) };
    json = JSON.stringify(value);
  }
  if (json.length > manager.prompt_max_chars) {
    value.recent_error_reports = value.recent_error_reports.slice(-1);
    value.active_task = value.active_task ? {
      task_id: value.active_task.task_id,
      kind: value.active_task.kind,
      status: value.active_task.status,
      attempt: value.active_task.attempt,
      last_error: value.active_task.last_error,
    } : null;
  }
  const softBudgetTokens = Math.floor(manager.context_window_tokens * manager.soft_budget_percent / 100);
  return {
    ...value,
    session_policy: {
      context_window_tokens: manager.context_window_tokens,
      max_output_tokens: manager.max_output_tokens,
      soft_budget_percent: manager.soft_budget_percent,
      soft_budget_tokens: softBudgetTokens,
      prompt_max_chars: manager.prompt_max_chars,
      polling_by_manager: false,
    },
  };
}
