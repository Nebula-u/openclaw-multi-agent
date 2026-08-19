import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

export function schemaBindingPath(projectRoot, sessionId) { return join(resolve(projectRoot), 'runtime', 'stategraph', 'schema-bindings', `${sessionId}.json`); }
export function bindEphemeralSchema({ projectRoot, task, cycle }) {
  const schemaFile = task.kind === 'MANAGER_ANALYSIS' ? 'route-plan.schema.json' : 'result.schema.json';
  const path = schemaBindingPath(projectRoot, task.session_id);
  mkdirSync(join(resolve(projectRoot), 'runtime', 'stategraph', 'schema-bindings'), { recursive: true });
  atomicWriteJson(path, { schema_version: 1, session_id: task.session_id, agent_id: task.agent_id, task_id: task.task_id, run_id: task.run_id, cycle, schema_path_abs: join(resolve(projectRoot), 'contracts', schemaFile), expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString() });
  return path;
}
export function consumeEphemeralSchema({ projectRoot, sessionId, agentId }) {
  if (!sessionId) return null;
  const path = schemaBindingPath(projectRoot, sessionId);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null;
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  if (binding.session_id !== sessionId || binding.agent_id !== agentId || Date.parse(binding.expires_at) <= Date.now()) return null;
  const schema = JSON.parse(readFileSync(binding.schema_path_abs, 'utf8'));
  return `# 本次调用临时 JSON Schema\n\n以下 Schema 仅注入本次模型调用，不属于会话历史。输出必须通过该 Schema：\n\n${JSON.stringify(schema)}`;
}
export function releaseEphemeralSchema(path) { if (path && existsSync(path)) unlinkSync(path); }
