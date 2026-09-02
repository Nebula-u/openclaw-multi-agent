#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openKernelDatabase, resolveKernelConfig } from './control-kernel/database.mjs';
import { createWorkflowRepository } from './control-kernel/workflow-repository.mjs';
import { createHrService } from './hr/service.mjs';
import { createGitWorktreeManager } from './orchestrator/git-worktree.mjs';
import { createSnapshotService } from './orchestrator/snapshot-service.mjs';
import { acquireOrchestratorWriterLock } from './orchestrator/foreground-service.mjs';

export async function main() {
  const projectRoot = resolve(process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd()); const config = resolveKernelConfig({ projectRoot });
  const lock = acquireOrchestratorWriterLock(projectRoot, { purpose: 'hr-runner' });
  let database;
  try {
    database = openKernelDatabase(config);
    const repository = createWorkflowRepository({ database });
    const snapshots = createSnapshotService({ repository, worktrees: createGitWorktreeManager({ projectRoot }) });
    const hr = createHrService({ projectRoot, repository, snapshots });
    process.stdout.write(`${JSON.stringify({ ok: true, jobs: await hr.runPending() }, null, 2)}\n`);
  } finally { database?.close(); lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
