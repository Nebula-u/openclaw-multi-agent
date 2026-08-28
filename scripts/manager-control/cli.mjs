#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManagerControl } from './service.mjs';
import { readOrchestratorStatus, submitOrchestratorApproval, submitWorkflowControl } from './orchestrator-state.mjs';

function fail(message) { throw Object.assign(new Error(message), { code: 'MANAGER_CONTROL_USAGE' }); }
function parse(argv) {
  const [action, ...tokens] = argv;
  if (!['ensure', 'resolve', 'fetch', 'orchestrator-status', 'orchestrator-approve', 'orchestrator-control'].includes(action)) fail('action is not supported');
  const allowedByAction = {
    ensure: new Set(['workflow-id', 'project-name', 'project-mode', 'remote-url']), resolve: new Set(['workflow-id', 'project-ref']), fetch: new Set(['workflow-id', 'project-ref']),
    'orchestrator-status': new Set(['workflow-id', 'manager-session-id', 'manager-session-key']),
    'orchestrator-approve': new Set(['workflow-id', 'manager-session-id', 'manager-session-key', 'decision-id', 'choice', 'authorization-summary', 'notes']),
    'orchestrator-control': new Set(['workflow-id', 'manager-session-id', 'manager-session-key', 'action', 'authorization-summary', 'notes']),
  };
  const allowed = allowedByAction[action];
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]; const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || !allowed.has(key.slice(2))) fail('arguments must be explicit supported --name value pairs');
    options[key.slice(2)] = value;
  }
  return { action, options };
}

function installedRuntimeRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }

function projectFromOptions(options) {
  const name = options['project-name'];
  const mode = options['project-mode'];
  const remoteUrl = options['remote-url'];
  if (typeof name !== 'string' || !name.trim()) fail('ensure requires a non-empty --project-name');
  if (!['new', 'remote'].includes(mode)) fail('ensure requires --project-mode new or remote');
  if (mode === 'new' && remoteUrl !== undefined) fail('--remote-url is only supported when --project-mode remote');
  if (mode === 'remote' && !remoteUrl) fail('--project-mode remote requires --remote-url');
  return mode === 'remote' ? { mode, name, remote_url: remoteUrl } : { mode, name };
}

function authorizationFromOptions(options) {
  const summary = options['authorization-summary'];
  if (typeof summary !== 'string' || !summary.trim()) fail('orchestrator-approve requires a non-empty --authorization-summary');
  return { confirmed: true, actor: 'human:manager', message: summary };
}

export function run(argv, output = process.stdout, { runtimeRoot = installedRuntimeRoot() } = {}) {
  const { action, options } = parse(argv);
  const control = createManagerControl({ runtimeRoot: resolve(runtimeRoot) });
  let result;
  if (action === 'ensure') {
    if (!options['workflow-id']) fail('ensure requires --workflow-id');
    const project = projectFromOptions(options);
    result = control.ensureProject({ workflowId: options['workflow-id'], project });
  } else if (action === 'resolve') {
    if (!options['project-ref'] || !options['workflow-id']) fail('resolve requires --project-ref and --workflow-id');
    result = control.resolveProject(options['project-ref'], options['workflow-id']);
  } else if (action === 'fetch') {
    if (!options['project-ref'] || !options['workflow-id']) fail('fetch requires --project-ref and --workflow-id');
    result = control.fetchProject(options['project-ref'], options['workflow-id']);
  } else if (action === 'orchestrator-status') {
    if (!options['workflow-id'] || !options['manager-session-id'] || !options['manager-session-key']) fail('orchestrator-status requires workflow and Manager session binding');
    result = readOrchestratorStatus({ runtimeRoot, workflowId: options['workflow-id'], managerSessionId: options['manager-session-id'], managerSessionKey: options['manager-session-key'] });
  } else if (action === 'orchestrator-approve') {
    if (!options['workflow-id'] || !options['manager-session-id'] || !options['manager-session-key'] || !options['decision-id'] || !options.choice) fail('orchestrator-approve requires workflow, Manager session, decision, and choice');
    const authorization = authorizationFromOptions(options);
    result = submitOrchestratorApproval({ runtimeRoot, workflowId: options['workflow-id'], managerSessionId: options['manager-session-id'], managerSessionKey: options['manager-session-key'],
      decisionId: options['decision-id'], choice: options.choice, authorization, notes: options.notes ?? '' });
  } else {
    if (!options['workflow-id'] || !options['manager-session-id'] || !options['manager-session-key'] || !options.action) fail('orchestrator-control requires workflow, Manager session, and action');
    if (!['PAUSE', 'RESUME'].includes(options.action)) fail('orchestrator-control action must be PAUSE or RESUME');
    const authorization = authorizationFromOptions(options);
    result = submitWorkflowControl({ runtimeRoot, workflowId: options['workflow-id'], managerSessionId: options['manager-session-id'], managerSessionKey: options['manager-session-key'],
      action: options.action, authorization, notes: options.notes ?? '' });
  }
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: error.code ?? 'MANAGER_CONTROL_FAILED', message: error.message, details: error.details ?? null })}\n`); process.exitCode = 1; }
}
