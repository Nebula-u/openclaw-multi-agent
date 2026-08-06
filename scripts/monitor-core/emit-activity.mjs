#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMonitorConfig } from '../../monitor/config.mjs';

function parseArgs(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    if (!tokens[index]?.startsWith('--') || tokens[index + 1] === undefined) throw new Error(`invalid argument: ${tokens[index] ?? ''}`);
    options[tokens[index].slice(2)] = tokens[index + 1];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.file) throw new Error('missing --file');
const config = loadMonitorConfig();
const token = options.token ?? config.token;
const base = options.url ?? process.env.MONITOR_URL ?? `http://${config.host}:${config.port}`;
const activity = JSON.parse(readFileSync(resolve(options.file), 'utf8'));
const response = await fetch(`${base.replace(/\/$/u, '')}/api/activity`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-monitor-token': token }, body: JSON.stringify(activity),
});
const result = await response.json();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = response.ok ? 0 : 1;
