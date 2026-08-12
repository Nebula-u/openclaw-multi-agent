export const MAX_AGENT_TIMEOUT_MS = 300_000;

export function validateAgentTimeoutMs(value, label = 'Agent timeout') {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AGENT_TIMEOUT_MS) {
    throw new Error(`${label} must be greater than 0 and no more than ${MAX_AGENT_TIMEOUT_MS}ms`);
  }
  return timeoutMs;
}
