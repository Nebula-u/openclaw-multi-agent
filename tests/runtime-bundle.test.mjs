import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildBundle } from '../scripts/runtime-bundle.mjs';

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

test('Manager runtime bundle includes the fixed manager-control entrypoint', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'runtime-bundle-manager-'));
  try {
    const bundle = buildBundle(ROOT, runtime, { agentIds: ['manager-agent'] });
    assert.equal(bundle.entries.some((entry) => entry.target_rel === 'manager-control/manager-control.cmd'), true);
    assert.equal(bundle.entries.some((entry) => entry.target_rel === 'manager-control/manager-control-policy.json'), true);
    assert.equal(bundle.entries.some((entry) => entry.target_rel === 'runtime-core/atomic-store.mjs'), true);
    assert.equal(bundle.entries.some((entry) => entry.target_rel === 'control-kernel/database.mjs'), true);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('Manager workspace requires quote-safe manager-control arguments', () => {
  const workspace = ['AGENTS.md', 'TOOLS.md']
    .map((name) => readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', name), 'utf8')).join('\n');
  assert.match(workspace, /--project-name/u);
  assert.match(workspace, /--project-mode/u);
  assert.match(workspace, /--authorization-summary/u);
  assert.doesNotMatch(workspace, /--project-json/u);
  assert.doesNotMatch(workspace, /--authorization-json/u);
});
test('bundled test-agent instructions distinguish staged Docker and assigned local execution paths', () => {
  
  const runtime = mkdtempSync(join(tmpdir(), 'runtime-bundle-test-agent-'));
  try {
    const bundle = buildBundle(ROOT, runtime, { agentIds: ['test-agent'] });
    const testAgentsEntry = bundle.entries.find((entry) => entry.target_rel === 'agents/test-agent/workspace/AGENTS.md');
    const testToolsEntry = bundle.entries.find((entry) => entry.target_rel === 'agents/test-agent/workspace/TOOLS.md');
    assert.ok(testAgentsEntry, 'test-agent AGENTS.md is included in the runtime bundle');
    assert.ok(testToolsEntry, 'test-agent TOOLS.md is included in the runtime bundle');
    for (const entry of bundle.entries) {
      const target = join(runtime, entry.target_rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(ROOT, entry.source_rel), target);
    }
    const testAgents = readFileSync(join(runtime, testAgentsEntry.target_rel), 'utf8');
    const testTools = readFileSync(join(runtime, testToolsEntry.target_rel), 'utf8');
    assert.match(testTools, /\/workspace\/\.task-sandbox\/repo/u);
    assert.match(testTools, /\/workspace\/\.task-sandbox\/input/u);
    assert.match(testTools, /\/workspace\/\.task-sandbox\/output/u);
    assert.match(testTools, /\/workspace\/\.task-sandbox\/raw-logs/u);
    assert.doesNotMatch(testTools, /\.agent-raw/u);
    assert.match(testAgents, /\/workspace\/\.task-sandbox\/repo/u);
    assert.match(testAgents, /\/workspace\/\.task-sandbox\/input/u);
    assert.match(testAgents, /\/workspace\/\.task-sandbox\/output/u);
    assert.match(testAgents, /\/workspace\/\.task-sandbox\/raw-logs/u);
    assert.match(testAgents, /worktree_path_abs/u);
    assert.match(testAgents, /UNSANDBOXED_LOCAL/u);
    for (const instructions of [testAgents, testTools]) {
      assert.doesNotMatch(instructions, /(?:^|[\s`"'])\/(?:worktree|input|agent-raw|raw-logs)(?:\/|`|\b)/u);
    }
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test('all worker packages receive the result hash and same-session JSON regeneration protocol', () => {
  const protocol = readFileSync(join(ROOT, 'agents', 'common', 'CONTEXT_PROTOCOL.md'), 'utf8');
  assert.match(protocol, /artifact_manifest_hash/u);
  assert.match(protocol, /context_manifest_sha256/u);
  assert.match(protocol, /同一 Session/u);
  assert.match(protocol, /不得重新执行任务/u);
  for (const agentId of ['requirement-agent', 'architect-agent', 'developer-agent', 'test-agent', 'review-agent', 'release-agent']) {
    const agentsMd = readFileSync(join(ROOT, 'agents', agentId, 'workspace', 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /artifact_manifest_hash/u, agentId);
    assert.match(agentsMd, /JSON 重生成/u, agentId);
  }
});
