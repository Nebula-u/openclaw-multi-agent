#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReleaseControl } from './service.mjs';

function fail(message) { throw Object.assign(new Error(message), { code: 'RELEASE_CONTROL_USAGE' }); }
function parse(argv) {
  const [action, ...tokens] = argv;
  if (!['preflight', 'deploy'].includes(action)) fail('action is not supported');
  const allowed = new Set(['workflow-id', 'project-id', 'candidate-commit']);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]; const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || !allowed.has(key.slice(2)) || Object.hasOwn(options, key.slice(2))) {
      fail('arguments must be explicit supported --name value pairs');
    }
    options[key.slice(2)] = value;
  }
  if (!options['workflow-id'] || !options['project-id'] || !options['candidate-commit']) fail(`${action} requires workflow, project, and candidate commit`);
  return { action, options };
}
function installedRuntimeRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }

export function run(argv, output = process.stdout, { runtimeRoot = installedRuntimeRoot() } = {}) {
  const { action, options } = parse(argv);
  const control = createReleaseControl({ runtimeRoot: resolve(runtimeRoot) });
  const fields = { workflowId: options['workflow-id'], projectId: options['project-id'], candidateCommit: options['candidate-commit'] };
  const result = action === 'preflight' ? control.preflight(fields) : control.deploy(fields);
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: error.code ?? 'RELEASE_CONTROL_FAILED', message: error.message, details: error.details ?? null })}\n`); process.exitCode = 1; }
}
