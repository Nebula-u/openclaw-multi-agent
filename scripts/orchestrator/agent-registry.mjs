import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class AgentRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
  }
}

export function loadActiveAgentRegistry(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const root = join(projectRoot, 'agents', 'packages', 'builtin');
  const agents = new Map();
  if (!existsSync(root)) return agents;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = JSON.parse(readFileSync(join(root, entry.name), 'utf8'));
    if (value.lifecycle?.active && value.lifecycle?.register) agents.set(value.id, value);
  }
  return agents;
}

export function assertOrchestratorWorker(registry, agentId) {
  const agent = registry.get(agentId);
  if (!agent || agent.role !== 'worker') throw new AgentRegistryError('ORCHESTRATOR_AGENT_NOT_REGISTERED', `not an active worker package: ${agentId}`);
  if ((agent.delegation?.allow_agents ?? []).length) throw new AgentRegistryError('ORCHESTRATOR_WORKER_DELEGATION_FORBIDDEN', `worker may not delegate: ${agentId}`);
  return agent;
}
