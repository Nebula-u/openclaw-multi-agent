import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class AgentRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
  }
}

function manifestPaths(projectRoot) {
  const builtin = join(projectRoot, 'agents', 'packages', 'builtin');
  const generated = join(projectRoot, 'agents', 'packages', 'generated', 'agents');
  const paths = [];
  if (existsSync(builtin)) paths.push(...readdirSync(builtin, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => join(builtin, entry.name)));
  if (existsSync(generated)) {
    for (const entry of readdirSync(generated, { withFileTypes: true })) {
      const path = join(generated, entry.name, 'agent.json');
      if (entry.isDirectory() && existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

export function loadActiveAgentRegistry(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const entries = new Map();
  for (const path of manifestPaths(projectRoot)) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value?.id || value.lifecycle?.register !== true || value.lifecycle?.active !== true) continue;
    if (entries.has(value.id)) throw new AgentRegistryError('ORCHESTRATOR_AGENT_DUPLICATE', `duplicate active Agent package: ${value.id}`);
    entries.set(value.id, { ...value, manifest_path_abs: path });
  }
  return entries;
}

export function assertDispatchableAgent(registry, task) {
  const agent = registry.get(task.assigned_agent);
  if (!agent || agent.role !== 'worker' || agent.delegation?.callable_by_manager !== true) {
    throw new AgentRegistryError('ORCHESTRATOR_AGENT_NOT_REGISTERED', `task Agent is not an active dispatchable worker: ${task.assigned_agent}`);
  }
  if ((agent.delegation?.allow_agents ?? []).length !== 0) {
    throw new AgentRegistryError('ORCHESTRATOR_WORKER_DELEGATION_FORBIDDEN', `worker Agent must not delegate: ${task.assigned_agent}`);
  }
  return agent;
}
