#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function filesBelow(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeRelative(root, path) {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`managed path escapes root: ${path}`);
  }
  return value.replaceAll('\\', '/');
}

function packageManifests(projectRoot) {
  return filesBelow(join(projectRoot, 'agents', 'packages'))
    .filter((path) => path.endsWith('.json'))
    .map((path) => ({ path, value: JSON.parse(readFileSync(path, 'utf8')) }))
    .filter(({ value }) => value.kind === 'openclaw-agent-package' && value.lifecycle?.register !== false);
}

function addTree(entries, projectRoot, runtimeRoot, sourceRoot, targetRoot, kind) {
  for (const sourcePath of filesBelow(sourceRoot)) {
    const sourceRelWithinTree = relative(sourceRoot, sourcePath);
    const targetPath = join(targetRoot, sourceRelWithinTree);
    entries.push({
      kind,
      source_rel: safeRelative(projectRoot, sourcePath),
      target_rel: safeRelative(runtimeRoot, targetPath),
      sha256: sha256File(sourcePath),
    });
  }
}

export function buildBundle(projectRootInput, runtimeRootInput) {
  const projectRoot = resolve(projectRootInput);
  const runtimeRoot = resolve(runtimeRootInput);
  const entries = [];
  for (const { value: manifest } of packageManifests(projectRoot)) {
    const sourceRoot = resolve(projectRoot, manifest.workspace_source_rel);
    const targetWorkspace = resolve(runtimeRoot, manifest.runtime_subdir, 'workspace');
    addTree(entries, projectRoot, runtimeRoot, sourceRoot, targetWorkspace, 'workspace');
    if (manifest.assembly?.include_common_rules) {
      addTree(entries, projectRoot, runtimeRoot, join(projectRoot, 'agents', 'common'), join(targetWorkspace, 'rules'), 'common-rule');
    }
    if (manifest.assembly?.include_templates) {
      addTree(entries, projectRoot, runtimeRoot, join(projectRoot, 'templates'), join(targetWorkspace, 'templates'), 'template');
    }
    for (const skill of manifest.skills ?? []) {
      addTree(entries, projectRoot, runtimeRoot,
        join(projectRoot, 'agents', 'packages', 'system', 'skills', skill),
        join(targetWorkspace, 'skills', skill), 'skill');
    }
  }
  entries.sort((left, right) => left.target_rel.localeCompare(right.target_rel, 'en')
    || left.source_rel.localeCompare(right.source_rel, 'en'));
  const targets = new Set();
  for (const entry of entries) {
    if (targets.has(entry.target_rel)) throw new Error(`duplicate managed runtime target: ${entry.target_rel}`);
    targets.add(entry.target_rel);
  }
  const digestInput = entries.map((entry) => `${entry.kind}\0${entry.source_rel}\0${entry.target_rel}\0${entry.sha256}`).join('\n');
  return {
    schema_version: 1,
    bundle_sha256: createHash('sha256').update(digestInput, 'utf8').digest('hex'),
    entries,
  };
}

function gitCommit(projectRoot) {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function record(projectRoot, runtimeRoot) {
  const bundle = buildBundle(projectRoot, runtimeRoot);
  const errors = [];
  for (const entry of bundle.entries) {
    const target = join(runtimeRoot, entry.target_rel);
    if (!existsSync(target)) errors.push({ code: 'RUNTIME_BUNDLE_TARGET_MISSING', path: target });
    else if (sha256File(target) !== entry.sha256) errors.push({ code: 'RUNTIME_BUNDLE_TARGET_DRIFT', path: target });
  }
  if (errors.length > 0) return { ok: false, command: 'record', errors };
  const manifest = {
    ...bundle,
    generated_at: new Date().toISOString(),
    project_root_abs: resolve(projectRoot),
    runtime_root_abs: resolve(runtimeRoot),
    source_git_commit: gitCommit(projectRoot),
  };
  const manifestPath = join(runtimeRoot, 'control', 'runtime-bundle.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ok: true, command: 'record', manifest_path: manifestPath, bundle_sha256: manifest.bundle_sha256, entries: manifest.entries.length };
}

function verify(projectRoot, runtimeRoot) {
  const manifestPath = join(runtimeRoot, 'control', 'runtime-bundle.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, command: 'verify', errors: [{ code: 'RUNTIME_BUNDLE_MANIFEST_MISSING', path: manifestPath }] };
  }
  const recorded = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const current = buildBundle(projectRoot, runtimeRoot);
  const errors = [];
  if (recorded.bundle_sha256 !== current.bundle_sha256) {
    errors.push({ code: 'RUNTIME_BUNDLE_SOURCE_DRIFT', path: manifestPath, expected: recorded.bundle_sha256, actual: current.bundle_sha256 });
  }
  for (const entry of current.entries) {
    const target = join(runtimeRoot, entry.target_rel);
    if (!existsSync(target)) errors.push({ code: 'RUNTIME_BUNDLE_TARGET_MISSING', path: target });
    else {
      const actual = sha256File(target);
      if (actual !== entry.sha256) errors.push({ code: 'RUNTIME_BUNDLE_TARGET_DRIFT', path: target, expected: entry.sha256, actual });
    }
  }
  return { ok: errors.length === 0, command: 'verify', bundle_sha256: current.bundle_sha256, entries: current.entries.length, errors };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(options['project-root'] ?? process.cwd());
  const runtimeRoot = resolve(options['runtime-root'] ?? join(projectRoot, 'runtime'));
  if (!['digest', 'record', 'verify'].includes(command)) throw new Error('usage: runtime-bundle.mjs <digest|record|verify> --project-root <abs> --runtime-root <abs>');
  const result = command === 'digest'
    ? { ok: true, command, ...buildBundle(projectRoot, runtimeRoot) }
    : command === 'record' ? record(projectRoot, runtimeRoot) : verify(projectRoot, runtimeRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
