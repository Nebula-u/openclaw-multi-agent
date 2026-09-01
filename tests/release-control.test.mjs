import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createReleaseControl } from '../scripts/release-control/service.mjs';
import { run as runReleaseControl } from '../scripts/release-control/cli.mjs';

const SHA = '1'.repeat(40);

function setup(t, { deploymentEntrypoint = null, runDeployment = null, verifyOnline = () => ({ status: 200 }) } = {}) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'release-control-'));
  const policyPath = join(runtimeRoot, 'release-control', 'release-control-policy.json');
  mkdirSync(join(runtimeRoot, 'release-control'), { recursive: true });
  writeFileSync(policyPath, `${JSON.stringify({ schema_version: 1, base_url: 'https://multiagentforge.cloud', deployment_target: 'current-server', deployment_entrypoint: deploymentEntrypoint })}\n`);
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  return { runtimeRoot, database, control: createReleaseControl({ runtimeRoot, policyPath, runDeployment, verifyOnline }) };
}

function approveDeployment(database, { workflowId, projectId, candidateCommit, urlPath }) {
  const timestamp = '2026-09-01T00:00:00.000Z';
  database.run(`INSERT INTO runs (run_id,workflow_id,request,request_sha256,target_project_root_abs,base_commit,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, ['RUN-release', workflowId, '{}', 'a'.repeat(64), '/tmp/project', SHA, timestamp, timestamp]);
  database.run(`INSERT INTO approvals (decision_id,run_id,trigger,request,response,status,created_at,resolved_at)
    VALUES (?,?,?,?,?,?,?,?)`, ['DEC-release', 'RUN-release', 'RELEASE_DEPLOYMENT', JSON.stringify({ deployment: {
    project_id: projectId, candidate_commit: candidateCommit, url_path: urlPath, base_url: 'https://multiagentforge.cloud', deployment_target: 'current-server',
  } }), JSON.stringify({ outcome: 'APPROVE_DEPLOY' }), 'RESOLVED', timestamp, timestamp]);
}

test('Release 为共享基础域名中的不同项目分配稳定且不冲突的路径', (t) => {
  const { control } = setup(t);

  const first = control.preflight({ workflowId: 'WF-Release-Path-1', projectId: 'todo-list', candidateCommit: SHA });
  const repeated = control.preflight({ workflowId: 'WF-Release-Path-1', projectId: 'todo-list', candidateCommit: SHA });
  const second = control.preflight({ workflowId: 'WF-Release-Path-2', projectId: 'todo-list', candidateCommit: SHA });

  assert.deepEqual(first, {
    workflow_id: 'WF-Release-Path-1', project_id: 'todo-list', candidate_commit: SHA,
    base_url: 'https://multiagentforge.cloud', url_path: '/todo-list', final_url: 'https://multiagentforge.cloud/todo-list',
    deployment_target: 'current-server', status: 'READY_TO_DEPLOY',
  });
  assert.deepEqual(repeated, first);
  assert.equal(second.url_path, '/todo-list-2');
  assert.equal(second.final_url, 'https://multiagentforge.cloud/todo-list-2');
});

test('Release 只在已批准的候选提交和路径上调用固定部署入口', (t) => {
  const entrypoint = join(tmpdir(), 'release-deploy-entrypoint');
  const calls = [];
  const { control, database, runtimeRoot } = setup(t, {
    deploymentEntrypoint: entrypoint,
    runDeployment(command, args) { calls.push({ command, args }); return { status: 0, stdout: 'deployed', stderr: '' }; },
  });
  const preflight = control.preflight({ workflowId: 'WF-Release-Deploy', projectId: 'todo-list', candidateCommit: SHA });
  approveDeployment(database, { workflowId: 'WF-Release-Deploy', projectId: 'todo-list', candidateCommit: SHA, urlPath: '/todo-list' });

  const deployed = control.deploy({ workflowId: 'WF-Release-Deploy', projectId: 'todo-list', candidateCommit: SHA });

  assert.equal(deployed.status, 'DEPLOYED');
  assert.equal(deployed.final_url, 'https://multiagentforge.cloud/todo-list');
  assert.deepEqual(calls, [{ command: entrypoint, args: ['--release-manifest', deployed.manifest_path_abs] }]);
  assert.equal(existsSync(deployed.manifest_path_abs), true);
  assert.deepEqual(JSON.parse(readFileSync(deployed.manifest_path_abs, 'utf8')), {
    schema_version: 1, workflow_id: 'WF-Release-Deploy', project_id: 'todo-list', candidate_commit: SHA,
    base_url: 'https://multiagentforge.cloud', url_path: preflight.url_path, final_url: preflight.final_url,
    deployment_target: 'current-server', approval_id: 'DEC-release',
  });
});

test('Release 拒绝未绑定到当前候选提交和路径的部署', (t) => {
  const { control, database } = setup(t, { deploymentEntrypoint: join(tmpdir(), 'release-deploy-entrypoint') });
  control.preflight({ workflowId: 'WF-Release-Deny', projectId: 'todo-list', candidateCommit: SHA });
  approveDeployment(database, { workflowId: 'WF-Release-Deny', projectId: 'todo-list', candidateCommit: '2'.repeat(40), urlPath: '/todo-list' });

  assert.throws(() => control.deploy({ workflowId: 'WF-Release-Deny', projectId: 'todo-list', candidateCommit: SHA }), (error) => error.code === 'RELEASE_DEPLOYMENT_APPROVAL_MISSING');
});

test('Release 在最终 URL 的线上检查失败时不将部署标记为成功', (t) => {
  const { control, database } = setup(t, {
    deploymentEntrypoint: join(tmpdir(), 'release-deploy-entrypoint'),
    runDeployment() { return { status: 0, stdout: 'deployed', stderr: '' }; },
    verifyOnline() { return { status: 503 }; },
  });
  control.preflight({ workflowId: 'WF-Release-Verify', projectId: 'todo-list', candidateCommit: SHA });
  approveDeployment(database, { workflowId: 'WF-Release-Verify', projectId: 'todo-list', candidateCommit: SHA, urlPath: '/todo-list' });

  assert.throws(
    () => control.deploy({ workflowId: 'WF-Release-Verify', projectId: 'todo-list', candidateCommit: SHA }),
    (error) => error.code === 'RELEASE_ONLINE_VERIFICATION_FAILED',
  );
});

test('Release CLI 只接受显式的受控部署参数', (t) => {
  const { runtimeRoot } = setup(t);
  const output = { value: '', write(text) { this.value += text; } };

  const result = runReleaseControl(['preflight', '--workflow-id', 'WF-Release-Cli', '--project-id', 'todo-list', '--candidate-commit', SHA], output, { runtimeRoot });

  assert.equal(result.final_url, 'https://multiagentforge.cloud/todo-list');
  assert.deepEqual(JSON.parse(output.value), result);
  assert.throws(() => runReleaseControl(['deploy', '--workflow-id', 'WF-Release-Cli', '--shell', 'whoami'], output, { runtimeRoot }), (error) => error.code === 'RELEASE_CONTROL_USAGE');
});
