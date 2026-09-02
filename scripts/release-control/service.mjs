import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { openKernelDatabase } from '../control-kernel/database.mjs';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

const WORKFLOW = /^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const URL_PATH = /^\/[a-z0-9][a-z0-9-]{0,80}$/u;
const ONLINE_VERIFY_TIMEOUT_MS = 15_000;
const ONLINE_VERIFY_SCRIPT = `
const url = process.argv[1];
fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(${ONLINE_VERIFY_TIMEOUT_MS}) })
  .then((response) => {
    process.stdout.write(JSON.stringify({ status: response.status }));
    process.exitCode = response.status >= 200 && response.status < 300 ? 0 : 1;
  })
  .catch(() => { process.exitCode = 1; });
`;

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function regular(path, code) {
  if (!existsSync(path)) fail(code, `required file is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code, `required file must be a regular non-symlink file: ${path}`);
}
function validWorkflow(value) { if (!WORKFLOW.test(value ?? '')) fail('RELEASE_WORKFLOW_ID_INVALID', 'workflow ID is invalid'); }
function validProject(value) { if (!PROJECT.test(value ?? '')) fail('RELEASE_PROJECT_ID_INVALID', 'project ID is invalid'); }
function validCommit(value) { if (!SHA.test(value ?? '')) fail('RELEASE_CANDIDATE_COMMIT_INVALID', 'candidate commit must be a full lowercase SHA'); }

export function createReleaseControl({ runtimeRoot: runtimeRootInput, policyPath: policyPathInput = null, runDeployment = null, verifyOnline = null, clock = () => new Date() } = {}) {
  if (!runtimeRootInput) throw new TypeError('runtimeRoot is required');
  const runtimeRoot = resolve(runtimeRootInput);
  const stateRoot = join(runtimeRoot, 'release-control');
  const registryPath = join(stateRoot, 'paths.json');
  const auditPath = join(stateRoot, 'audit.jsonl');
  const manifestsRoot = join(stateRoot, 'manifests');
  const policyPath = resolve(policyPathInput ?? join(stateRoot, 'release-control-policy.json'));
  const invoke = runDeployment ?? ((command, args) => spawnSync(command, args, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 300_000 }));
  const onlineCheck = verifyOnline ?? ((url) => {
    const check = spawnSync(process.execPath, ['-e', ONLINE_VERIFY_SCRIPT, url], { shell: false, windowsHide: true, encoding: 'utf8', timeout: ONLINE_VERIFY_TIMEOUT_MS + 1_000 });
    if (check.error || check.status !== 0) return { status: null };
    try {
      const value = JSON.parse(check.stdout);
      return Number.isInteger(value?.status) ? { status: value.status } : { status: null };
    } catch { return { status: null }; }
  });

  function policy() {
    regular(policyPath, 'RELEASE_DEPLOYMENT_POLICY_MISSING');
    let value;
    try { value = JSON.parse(readFileSync(policyPath, 'utf8')); }
    catch { fail('RELEASE_DEPLOYMENT_POLICY_INVALID', 'release deployment policy is not valid JSON'); }
    if (value?.schema_version !== 1 || value.base_url !== 'https://multiagentforge.cloud' || typeof value.deployment_target !== 'string' || !value.deployment_target) {
      fail('RELEASE_DEPLOYMENT_POLICY_INVALID', 'release deployment policy has an unsupported shape');
    }
    if (value.deployment_entrypoint !== null && (typeof value.deployment_entrypoint !== 'string' || !isAbsolute(value.deployment_entrypoint))) {
      fail('RELEASE_DEPLOYMENT_POLICY_INVALID', 'deployment entrypoint must be null or an absolute path');
    }
    const reservedUrlPaths = value.reserved_url_paths ?? [];
    if (!Array.isArray(reservedUrlPaths) || new Set(reservedUrlPaths).size !== reservedUrlPaths.length || reservedUrlPaths.some((path) => typeof path !== 'string' || !URL_PATH.test(path))) {
      fail('RELEASE_DEPLOYMENT_POLICY_INVALID', 'reserved URL paths must be unique absolute lowercase project paths');
    }
    return { ...value, reserved_url_paths: reservedUrlPaths };
  }
  function registry() {
    if (!existsSync(registryPath)) return { schema_version: 1, reservations: {} };
    regular(registryPath, 'RELEASE_PATH_REGISTRY_UNSAFE');
    let value;
    try { value = JSON.parse(readFileSync(registryPath, 'utf8')); }
    catch { fail('RELEASE_PATH_REGISTRY_INVALID', 'release path registry is not valid JSON'); }
    if (value?.schema_version !== 1 || !value.reservations || Array.isArray(value.reservations)) fail('RELEASE_PATH_REGISTRY_INVALID', 'release path registry has an unsupported shape');
    return value;
  }
  function writeRegistry(value) { mkdirSync(stateRoot, { recursive: true }); atomicWriteJson(registryPath, value); }
  function audit(action, details) { mkdirSync(stateRoot, { recursive: true }); appendFileSync(auditPath, `${JSON.stringify({ schema_version: 1, action, occurred_at: clock().toISOString(), details })}\n`, 'utf8'); }
  function reservationKey(workflowId, projectId) { return `${workflowId}:${projectId}`; }
  function result(reservation) {
    return {
      workflow_id: reservation.workflow_id, project_id: reservation.project_id, candidate_commit: reservation.candidate_commit,
      base_url: reservation.base_url, url_path: reservation.url_path, final_url: `${reservation.base_url}${reservation.url_path}`,
      deployment_target: reservation.deployment_target, status: reservation.status,
    };
  }
  function preflight({ workflowId, projectId, candidateCommit }) {
    validWorkflow(workflowId); validProject(projectId); validCommit(candidateCommit);
    const configured = policy(); const value = registry(); const key = reservationKey(workflowId, projectId);
    const existing = value.reservations[key];
    if (existing) {
      if (existing.candidate_commit !== candidateCommit) fail('RELEASE_PREFLIGHT_COMMIT_CHANGED', 'a new candidate commit requires a new deployment route');
      return result(existing);
    }
    const used = new Set([...configured.reserved_url_paths, ...Object.values(value.reservations).map((item) => item.url_path)]);
    let suffix = 1; let urlPath = `/${projectId}`;
    while (used.has(urlPath)) { suffix += 1; urlPath = `/${projectId}-${suffix}`; }
    const reservation = {
      workflow_id: workflowId, project_id: projectId, candidate_commit: candidateCommit, base_url: configured.base_url,
      url_path: urlPath, deployment_target: configured.deployment_target, status: 'READY_TO_DEPLOY', created_at: clock().toISOString(),
    };
    value.reservations[key] = reservation; writeRegistry(value); audit('release.preflight', result(reservation));
    return result(reservation);
  }
  function approvedDeployment({ workflowId, projectId, candidateCommit, urlPath, baseUrl, deploymentTarget }) {
    const databasePath = join(runtimeRoot, 'control', 'kernel.db');
    regular(databasePath, 'RELEASE_KERNEL_DATABASE_MISSING');
    const database = openKernelDatabase({ databasePath, readonly: true, initialize: false });
    try {
      const approvals = database.all(`SELECT approvals.decision_id,approvals.request,approvals.response FROM approvals
        JOIN runs ON runs.run_id=approvals.run_id WHERE runs.workflow_id=? AND approvals.trigger='RELEASE_DEPLOYMENT' AND approvals.status='RESOLVED'
        ORDER BY approvals.resolved_at DESC, approvals.created_at DESC`, [workflowId]);
      for (const approval of approvals) {
        let request; let response;
        try { request = JSON.parse(approval.request); response = JSON.parse(approval.response); } catch { continue; }
        const deployment = request?.deployment;
        if (response?.outcome === 'APPROVE_DEPLOY' && deployment?.project_id === projectId && deployment?.candidate_commit === candidateCommit
          && deployment?.url_path === urlPath && deployment?.base_url === baseUrl && deployment?.deployment_target === deploymentTarget) return approval.decision_id;
      }
    } finally { database.close(); }
    fail('RELEASE_DEPLOYMENT_APPROVAL_MISSING', 'no resolved deployment approval binds the current candidate commit and URL path');
  }
  function deploy({ workflowId, projectId, candidateCommit }) {
    validWorkflow(workflowId); validProject(projectId); validCommit(candidateCommit);
    const configured = policy(); const value = registry(); const reservation = value.reservations[reservationKey(workflowId, projectId)];
    if (!reservation || reservation.candidate_commit !== candidateCommit || reservation.status !== 'READY_TO_DEPLOY') {
      fail('RELEASE_DEPLOYMENT_PREFLIGHT_MISSING', 'deployment requires a matching READY_TO_DEPLOY preflight reservation');
    }
    const approvalId = approvedDeployment({ workflowId, projectId, candidateCommit, urlPath: reservation.url_path, baseUrl: reservation.base_url, deploymentTarget: reservation.deployment_target });
    if (!configured.deployment_entrypoint) fail('RELEASE_DEPLOYMENT_NOT_CONFIGURED', 'the server deployment entrypoint is not configured');
    if (!runDeployment) regular(configured.deployment_entrypoint, 'RELEASE_DEPLOYMENT_ENTRYPOINT_UNSAFE');
    mkdirSync(manifestsRoot, { recursive: true });
    const manifestPath = join(manifestsRoot, `${workflowId}-${projectId}.json`);
    const manifest = { schema_version: 1, workflow_id: workflowId, project_id: projectId, candidate_commit: candidateCommit,
      base_url: reservation.base_url, url_path: reservation.url_path, final_url: `${reservation.base_url}${reservation.url_path}`,
      deployment_target: reservation.deployment_target, approval_id: approvalId };
    atomicWriteJson(manifestPath, manifest);
    const execution = invoke(configured.deployment_entrypoint, ['--release-manifest', manifestPath]);
    if (execution?.error || execution?.status !== 0) {
      audit('release.deploy', { ...manifest, status: 'DEPLOY_FAILED', exit_code: execution?.status ?? null });
      fail('RELEASE_DEPLOYMENT_EXECUTION_FAILED', 'configured deployment entrypoint failed', { status: execution?.status ?? null, stderr: String(execution?.stderr ?? '').trim() });
    }
    const verification = onlineCheck(manifest.final_url);
    if (!Number.isInteger(verification?.status) || verification.status < 200 || verification.status >= 300) {
      audit('release.online-verification', { ...manifest, status: 'ONLINE_VERIFICATION_FAILED', http_status: verification?.status ?? null });
      fail('RELEASE_ONLINE_VERIFICATION_FAILED', 'the deployed final URL did not return a successful HTTP response', { status: verification?.status ?? null });
    }
    reservation.status = 'DEPLOYED'; reservation.deployed_at = clock().toISOString(); reservation.approval_id = approvalId;
    value.reservations[reservationKey(workflowId, projectId)] = reservation; writeRegistry(value); audit('release.deploy', { ...manifest, status: 'DEPLOYED' });
    return { ...result(reservation), manifest_path_abs: manifestPath, online_verification: { url: manifest.final_url, http_status: verification.status } };
  }
  return { preflight, deploy, registryPath, auditPath, manifestsRoot };
}
