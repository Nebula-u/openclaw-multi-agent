/**
 * Executor boundary for StateGraph task processes. Reconciliation remains in
 * dispatcher so every executor writes the existing durable result contract.
 */
export function createOpenClawExecutor({ launch }) {
  if (typeof launch !== 'function') throw new TypeError('launch must be a function');
  return {
    kind: 'openclaw',
    async start(input) {
      return launch(input);
    },
  };
}

export function assertExecutor(executor) {
  if (!executor || typeof executor.start !== 'function') {
    throw Object.assign(new TypeError('executor.start must be a function'), { code: 'AGENT_EXECUTOR_INVALID' });
  }
  return executor;
}
