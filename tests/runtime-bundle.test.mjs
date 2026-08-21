import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'runtime-bundle.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-bundle-'));
  const project = join(root, 'project');
  const runtime = join(root, 'runtime');
  mkdirSync(join(project, 'agents', 'packages', 'builtin'), { recursive: true });
  mkdirSync(join(project, 'agents', 'demo', 'workspace'), { recursive: true });
  mkdirSync(join(project, 'agents', 'common'), { recursive: true });
  mkdirSync(join(project, 'templates'), { recursive: true });
  writeFileSync(join(project, 'agents', 'packages', 'builtin', 'demo.json'), JSON.stringify({
    schema_version: 1,
    kind: 'openclaw-agent-package',
    id: 'demo',
    workspace_source_rel: 'agents/demo/workspace',
    runtime_subdir: 'agents/demo',
    assembly: { include_common_rules: true, include_templates: true },
    skills: [],
    lifecycle: { register: true },
  }));
  writeFileSync(join(project, 'agents', 'demo', 'workspace', 'AGENTS.md'), 'v1\n');
  writeFileSync(join(project, 'agents', 'common', 'COMMON.md'), 'rule\n');
  writeFileSync(join(project, 'templates', 'result.json'), '{}\n');
  cpSync(join(project, 'agents', 'demo', 'workspace'), join(runtime, 'agents', 'demo', 'workspace'), { recursive: true });
  cpSync(join(project, 'agents', 'common'), join(runtime, 'agents', 'demo', 'workspace', 'rules'), { recursive: true });
  cpSync(join(project, 'templates'), join(runtime, 'agents', 'demo', 'workspace', 'templates'), { recursive: true });
  return { root, project, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(command, value, agentIds = null) {
  const args = [SCRIPT, command, '--project-root', value.project, '--runtime-root', value.runtime];
  if (agentIds) args.push('--agent-ids', agentIds);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

test('runtime bundle records and verifies managed workspace content', () => {
  const value = fixture();
  try {
    const recorded = run('record', value);
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const manifest = JSON.parse(readFileSync(join(value.runtime, 'control', 'runtime-bundle.json'), 'utf8'));
    assert.equal(manifest.entries.length, 3);
    const verified = run('verify', value);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  } finally { value.cleanup(); }
});

test('runtime bundle rejects source or installed workspace drift', () => {
  const value = fixture();
  try {
    assert.equal(run('record', value).status, 0);
    writeFileSync(join(value.project, 'agents', 'demo', 'workspace', 'AGENTS.md'), 'v2\n');
    const sourceDrift = run('verify', value);
    assert.equal(sourceDrift.status, 1);
    assert.match(sourceDrift.stdout, /RUNTIME_BUNDLE_SOURCE_DRIFT/);
    writeFileSync(join(value.project, 'agents', 'demo', 'workspace', 'AGENTS.md'), 'v1\n');
    writeFileSync(join(value.runtime, 'agents', 'demo', 'workspace', 'AGENTS.md'), 'tampered\n');
    const targetDrift = run('verify', value);
    assert.equal(targetDrift.status, 1);
    assert.match(targetDrift.stdout, /RUNTIME_BUNDLE_TARGET_DRIFT/);
  } finally { value.cleanup(); }
});

test('filtered bundle records only selected installed Agents', () => {
  const value = fixture();
  try {
    mkdirSync(join(value.project, 'agents', 'dialogue', 'workspace'), { recursive: true });
    writeFileSync(join(value.project, 'agents', 'packages', 'builtin', 'dialogue.json'), JSON.stringify({
      schema_version: 1,
      kind: 'openclaw-agent-package',
      id: 'dialogue-agent',
      workspace_source_rel: 'agents/dialogue/workspace',
      runtime_subdir: 'agents/dialogue-agent',
      assembly: { include_common_rules: false, include_templates: false },
      skills: [],
      lifecycle: { register: true },
    }));
    writeFileSync(join(value.project, 'agents', 'dialogue', 'workspace', 'AGENTS.md'), 'not installed\n');

    const recorded = run('record', value, 'demo');
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const manifest = JSON.parse(readFileSync(join(value.runtime, 'control', 'runtime-bundle.json'), 'utf8'));
    assert.deepEqual(manifest.agent_ids, ['demo']);
    assert.equal(manifest.entries.some((entry) => entry.target_rel.startsWith('agents/dialogue-agent/')), false);
    assert.equal(run('verify', value).status, 0);
  } finally { value.cleanup(); }
});

test('HR package is manual-first and limited to the three Session review categories', () => {
  const workspace = ['AGENTS.md', 'SOUL.md', 'TOOLS.md']
    .map((name) => readFileSync(join(ROOT, 'agents', 'hr-agent', 'workspace', name), 'utf8')).join('\n');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', 'hr-agent.json'), 'utf8'));
  assert.match(workspace, /UNAUTHORIZED_ACTION[\s\S]*UNCLEAR_BOUNDARY[\s\S]*SPECULATIVE_OR_VAGUE/u);
  assert.match(workspace, /thinking\/reasoning/u);
  assert.match(workspace, /manual-by-default[\s\S]*explicitly enabled host automation policy/u);
  assert.match(workspace, /category[\s\S]*severity[\s\S]*evidence_locator[\s\S]*shortest_redacted_excerpt[\s\S]*explanation[\s\S]*recommendation/u);
  assert.doesNotMatch(workspace, /Never.*read thinking/iu);
  assert.deepEqual(manifest.capabilities, ['observability.session-review', 'observability.git-review', 'automation.review-hook']);
  assert.equal(manifest.delegation.callable_by_manager, false);
});
