#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const yes = args.has('--yes');
if (args.has('--help') || args.has('-h')) {
  console.log('用法: node scripts/inject-openclaw-models.mjs [--apply --yes] [--thinking-path=<dotpath>]');
  console.log('默认读取项目根 .env，仅预演；--apply --yes 才写入 OpenClaw。');
  process.exit(0);
}
const thinkingPathArg = process.argv.find((arg) => arg.startsWith('--thinking-path='));
const thinkingPath = thinkingPathArg?.slice('--thinking-path='.length) || 'agents.defaults.thinkingDefault';

export function modelEnvironmentKey(agentId) {
  return `OPENCLAW_AGENT_${agentId.replaceAll('-', '_').toUpperCase()}_MODEL`;
}

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = readEnvFile(path.join(projectRoot, '.env'));
const env = (key) => process.env[key] ?? fileEnv[key];
const validThinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra']);
const thinking = env('OPENCLAW_THINKING_LEVEL') || 'high';
if (!validThinking.has(thinking)) throw new Error(`OPENCLAW_THINKING_LEVEL 必须是 ${[...validThinking].join(', ')} 之一`);

function openclaw(cliArgs) {
  let command = 'openclaw';
  let commandArgs = cliArgs;
  if (process.platform === 'win32') {
    const located = spawnSync('where.exe', ['openclaw.cmd'], { encoding: 'utf8' });
    const shim = (located.stdout || '').split(/\r?\n/).find(Boolean);
    if (!shim) throw new Error('未在 PATH 中找到 openclaw.cmd。');
    const entrypoint = path.join(path.dirname(shim), 'node_modules', 'openclaw', 'openclaw.mjs');
    if (!fs.existsSync(entrypoint)) throw new Error(`未找到 OpenClaw CLI 入口: ${entrypoint}`);
    command = process.execPath;
    commandArgs = [entrypoint, ...cliArgs];
  }
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stdout || '') + (result.stderr || ''));
  return (result.stdout || '').trim();
}

function parseJson(output, label) {
  const start = output.indexOf('{');
  const listStart = output.indexOf('[');
  const at = start < 0 ? listStart : listStart < 0 ? start : Math.min(start, listStart);
  try { return JSON.parse(at > 0 ? output.slice(at) : output); } catch { throw new Error(`${label} 不是有效 JSON`); }
}

const agents = parseJson(openclaw(['config', 'get', 'agents.list', '--json']), 'agents.list');
const changes = [];
const desiredAgents = structuredClone(agents);
for (let index = 0; index < agents.length; index++) {
  const agent = agents[index];
  const key = modelEnvironmentKey(agent.id);
  const model = env(key);
  if (model && model !== agent.model) {
    desiredAgents[index].model = model;
    changes.push({ path: `agents.list[${index}].model`, value: model, label: `${agent.id}.model=${model}` });
  }
}
changes.push({ path: thinkingPath, value: thinking, label: `${thinkingPath}=${thinking}` });

console.log(`== OpenClaw 模型/思考强度注入 (${apply ? 'APPLY' : 'DRYRUN'}) ==`);
for (const change of changes) console.log(`  ${apply ? 'SET' : 'WOULD SET'} ${change.label}`);
if (!apply) { console.log('预演完成。使用 --apply --yes 写入配置。'); process.exit(0); }
if (!yes) throw new Error('实际写入需要同时提供 --yes，避免误改 OpenClaw 配置。');
if (thinkingPath !== 'agents.defaults.thinkingDefault') throw new Error('当前版本仅支持 agents.defaults.thinkingDefault 作为统一思考强度路径。');

// config patch applies this read-modify-write set atomically, avoiding Windows
// CLI timeouts that can otherwise leave a per-Agent update only partly applied.
const patchPath = path.join(projectRoot, `.openclaw-model-injection-${process.pid}.json`);
fs.writeFileSync(patchPath, JSON.stringify({ agents: { list: desiredAgents, defaults: { thinkingDefault: thinking } } }));
try {
  openclaw(['config', 'patch', '--file', patchPath, '--dry-run', '--json']);
  openclaw(['config', 'patch', '--file', patchPath]);
} finally {
  fs.rmSync(patchPath, { force: true });
}
openclaw(['config', 'validate', '--json']);
console.log('注入完成，OpenClaw 配置校验通过。');
