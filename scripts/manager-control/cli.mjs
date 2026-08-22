#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManagerControl } from './service.mjs';

function fail(message) { throw Object.assign(new Error(message), { code: 'MANAGER_CONTROL_USAGE' }); }
function parse(argv) {
  const [action, ...tokens] = argv;
  if (!['ensure', 'resolve', 'fetch'].includes(action)) fail('action must be ensure, resolve, or fetch');
  const allowed = new Set(['workflow-id', 'project-json', 'project-ref']);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]; const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || !allowed.has(key.slice(2))) fail('arguments must be explicit supported --name value pairs');
    options[key.slice(2)] = value;
  }
  return { action, options };
}

function installedRuntimeRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }

export function run(argv, output = process.stdout, { runtimeRoot = installedRuntimeRoot() } = {}) {
  const { action, options } = parse(argv);
  const control = createManagerControl({ runtimeRoot: resolve(runtimeRoot) });
  let result;
  if (action === 'ensure') {
    if (!options['workflow-id'] || !options['project-json']) fail('ensure requires --workflow-id and --project-json');
    let project;
    try { project = JSON.parse(options['project-json']); } catch { fail('--project-json must be valid JSON'); }
    result = control.ensureProject({ workflowId: options['workflow-id'], project });
  } else if (action === 'resolve') {
    if (!options['project-ref'] || !options['workflow-id']) fail('resolve requires --project-ref and --workflow-id');
    result = control.resolveProject(options['project-ref'], options['workflow-id']);
  } else {
    if (!options['project-ref'] || !options['workflow-id']) fail('fetch requires --project-ref and --workflow-id');
    result = control.fetchProject(options['project-ref'], options['workflow-id']);
  }
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: error.code ?? 'MANAGER_CONTROL_FAILED', message: error.message, details: error.details ?? null })}\n`); process.exitCode = 1; }
}
