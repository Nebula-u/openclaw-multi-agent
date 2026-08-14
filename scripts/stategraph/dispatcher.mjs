import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWriteFile, atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { ingestTaskOutput, rawOutputPath } from './output-ingestion.mjs';
import { agentEnvironment } from './authority.mjs';
import { createContextManifest, verifyContextManifest } from './context-manifest.mjs';
import { assertSandboxAttestation, prepareTestSandboxSession } from './sandbox-runtime.mjs';

function inside(root, path) {
  if (!isAbsolute(root) || !isAbsolute(path)) return false;
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function cyclePaths(task, cycle) {
  const root = join(task.artifact_root_abs, '.stategraph-dispatch', `attempt-${task.attempt}`, `cycle-${cycle}`);
  return {
    root,
    message_path_abs: join(root, 'message.md'),
    launcher_path_abs: join(root, 'launcher.json'),
    status_path_abs: join(root, 'status.json'),
    result_path_abs: join(root, 'result.json'),
    stdout_path_abs: join(root, 'stdout.log'),
    stderr_path_abs: join(root, 'stderr.log'),
    raw_log_path_abs: join(task.artifact_root_abs, 'logs', 'agent-process.jsonl'),
  };
}

function taskMessage(task, cycle, repairError = null, sandbox = null) {
  const outputPath = sandbox ? `/agent-raw/${task.kind === 'MANAGER_ANALYSIS' ? 'route-plan.json.raw' : 'result.json.raw'}` : rawOutputPath(task);
  const worktreePath = sandbox ? '/worktree' : task.worktree_path_abs;
  const manifestPath = sandbox ? '/input/context-manifest.json' : task.context_manifest_path_abs;
  if (cycle > 0) {
    return `# JSON 重新生成 ${cycle}/2\n\n你仍是 ${task.agent_id}，继续使用同一 session。上次输出未通过本地信任边界：\n\n${JSON.stringify(repairError, null, 2)}\n\n只重新生成不合法的结构化文件。必须覆盖写入：\n${outputPath}\n\n不要解释，不要改变任务、Agent、run、attempt、context manifest 或路由。`;
  }
  const expected = task.kind === 'MANAGER_ANALYSIS'
    ? `分析用户需求，生成本轮动态路线。只写 route-plan JSON 到 ${outputPath}。所有省略阶段必须写 skipped_stages 理由；需要的人工审批写 human_approval_after。不得填写 Agent ID，Agent 由代码强制映射。`
    : `完成 ${task.kind} 任务，并把 result.schema.json 对象写到 ${outputPath}。self_validation.checks 必须逐项包含：${task.required_gate_checks.join(', ')}。artifact_manifest_hash 必须等于 context_manifest_sha256。所有身份、commit 和主机路径字段必须与 context manifest 完全一致。`;
  const sandboxText = sandbox ? `\n\n## 强制 Docker 沙箱\n\n本次 test-agent 只能使用 /worktree（读写）、/input（只读）、/agent-raw（读写）、/raw-logs（读写）；禁止主机执行、提权和网络。实际文件访问使用容器路径，但 result 与 CommandRecord 的身份/路径字段必须使用 /input/task.json 的 host_task_metadata 主机值，以便本地代码校验。isolation_mode 必须为 SANDBOXED_DOCKER，sandbox_attestation 必须逐字复制以下代码验证对象：\n\n${JSON.stringify(sandbox.attestation, null, 2)}` : '';
  return `# StateGraph 强制分发任务\n\n- workflow_id: ${task.workflow_id}\n- task_id: ${task.task_id}\n- run_id: ${task.run_id}\n- step_id: ${task.step_id}\n- assigned_agent: ${task.agent_id}\n- attempt: ${task.attempt}\n- input_commit: ${task.input_commit}\n- worktree_path_abs: ${worktreePath}\n- artifact_root_abs: ${sandbox ? '/agent-raw' : task.artifact_root_abs}\n- context_manifest_path_abs: ${manifestPath}\n- context_manifest_sha256: ${task.context_manifest_sha256}\n\n${expected}\n\n## 任务上下文\n\n${task.prompt}${sandboxText}\n\n禁止调用其他 Agent、禁止修改路线或审批计划、禁止写最终 output 目录、禁止把聊天文本当作完成证据。`;
}

export function launchDetachedAgent({ task, cycle, paths, timeoutSeconds, sandboxLeasePath = null }) {
  const runner = resolve(import.meta.dirname, 'agent-runner.mjs');
  const args = [runner,
    '--agent-id', task.agent_id,
    '--session-id', task.session_id,
    '--message-path', paths.message_path_abs,
    '--timeout-seconds', String(timeoutSeconds),
    '--stdout-path', paths.stdout_path_abs,
    '--stderr-path', paths.stderr_path_abs,
    '--status-path', paths.status_path_abs,
    '--result-path', paths.result_path_abs,
    '--raw-log-path', paths.raw_log_path_abs,
    '--dispatch-id', `DSP-${task.run_id.slice(4)}-${cycle}`,
    '--cycle', String(cycle),
    ...(sandboxLeasePath ? ['--sandbox-lease-path', sandboxLeasePath] : []),
  ];
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', shell: false, env: agentEnvironment() });
  child.unref();
  return { launcher_pid: child.pid };
}

export function createForcedDispatcher({ projectRoot: projectRootInput, policy, launch = launchDetachedAgent,
  clock = () => new Date(), uuid = randomUUID, worktrees = null, sandboxCommandRunner = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const artifactBoundary = join(projectRoot, 'runtime', 'artifacts');

  function assertTask(task) {
    if (policy.task_agents[task.kind] !== task.agent_id) throw Object.assign(new Error('Agent assignment is not the fixed policy mapping'), { code: 'DISPATCH_AGENT_POLICY_MISMATCH' });
    if (!inside(artifactBoundary, task.artifact_root_abs)) throw Object.assign(new Error('artifact root escapes runtime/artifacts'), { code: 'DISPATCH_ARTIFACT_ESCAPE' });
    if (!isAbsolute(task.worktree_path_abs)) throw Object.assign(new Error('worktree path must be absolute'), { code: 'DISPATCH_WORKTREE_NOT_ABSOLUTE' });
  }

  async function start(taskInput) {
    const task = structuredClone(taskInput);
    assertTask(task);
    if (worktrees) {
      const prepared = worktrees.prepare(task);
      task.worktree_path_abs = prepared.worktree_path_abs;
    } else if (!existsSync(task.worktree_path_abs)) {
      throw Object.assign(new Error(`worktree does not exist: ${task.worktree_path_abs}`), { code: 'DISPATCH_WORKTREE_MISSING' });
    }
    if (!task.session_id) task.session_id = uuid();
    if (!task.context_manifest_path_abs) {
      const context = createContextManifest({ projectRoot, task, occurredAt: clock().toISOString() });
      task.context_manifest_path_abs = context.path;
      task.context_manifest_sha256 = context.sha256;
    } else verifyContextManifest({ projectRoot, task });
    const cycle = task.status === 'REPAIR_READY' ? task.json_regenerations : 0;
    const paths = cyclePaths(task, cycle);
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(join(task.artifact_root_abs, '.agent-raw'), { recursive: true });
    mkdirSync(join(task.artifact_root_abs, 'logs'), { recursive: true });
    const dispatchId = `DSP-${task.run_id.slice(4)}-${cycle}`;
    let sandbox = null;
    if (!existsSync(paths.launcher_path_abs)) {
      sandbox = task.kind === 'TEST' ? await prepareTestSandboxSession({
        projectRootInput: projectRoot,
        task,
        sessionId: task.session_id,
        sessionKey: `agent:test-agent:stategraph:${task.workflow_id}:${task.task_id}:${task.run_id}`,
        runtimeRootAbs: join(projectRoot, 'runtime'),
        commandRunner: sandboxCommandRunner,
      }) : null;
      atomicWriteFile(paths.message_path_abs, taskMessage(task, cycle, task.last_error, sandbox));
      atomicWriteJson(paths.launcher_path_abs, {
        schema_version: 1,
        dispatch_id: dispatchId,
        workflow_id: task.workflow_id,
        task_id: task.task_id,
        run_id: task.run_id,
        agent_id: task.agent_id,
        session_id: task.session_id,
        attempt: task.attempt,
        cycle,
        created_at: clock().toISOString(),
        context_manifest_path_abs: task.context_manifest_path_abs,
        context_manifest_sha256: task.context_manifest_sha256,
        sandbox_lease_path_abs: sandbox?.leasePath ?? null,
        sandbox_mount_plan: sandbox?.mountPlan ?? null,
        ...paths,
      });
      const launched = await launch({ task, cycle, paths, timeoutSeconds: policy.agent_timeout_seconds, sandboxLeasePath: sandbox?.leasePath ?? null });
      atomicWriteJson(paths.launcher_path_abs, {
        ...JSON.parse(readFileSync(paths.launcher_path_abs, 'utf8')),
        launcher_pid: launched?.launcher_pid ?? null,
      });
    } else {
      const launcher = JSON.parse(readFileSync(paths.launcher_path_abs, 'utf8'));
      sandbox = launcher.sandbox_lease_path_abs ? {
        leasePath: launcher.sandbox_lease_path_abs,
        mountPlan: launcher.sandbox_mount_plan,
      } : null;
    }
    task.status = 'DISPATCHED';
    task.current_cycle = cycle;
    task.dispatches = [...(task.dispatches ?? []), ...((task.dispatches ?? []).some((item) => item.dispatch_id === dispatchId) ? [] : [{
      dispatch_id: dispatchId,
      cycle,
      status: 'DISPATCHED',
      launcher_path_abs: paths.launcher_path_abs,
      context_manifest_sha256: task.context_manifest_sha256,
      sandbox_lease_path_abs: sandbox?.leasePath ?? null,
      created_at: clock().toISOString(),
    }])];
    task.updated_at = clock().toISOString();
    return task;
  }

  function reconcile(taskInput) {
    const task = structuredClone(taskInput);
    assertTask(task);
    try { verifyContextManifest({ projectRoot, task }); }
    catch (error) { return { kind: 'ERROR', code: error.code ?? 'CONTEXT_INTEGRITY_FAILED', message: error.message, details: error.details ?? null, task }; }
    const cycle = task.current_cycle ?? 0;
    const paths = cyclePaths(task, cycle);
    if (!existsSync(paths.launcher_path_abs)) return { kind: 'ERROR', code: 'DISPATCH_LAUNCHER_MISSING', message: 'durable launcher evidence is missing', task };
    if (!existsSync(paths.result_path_abs)) {
      task.status = existsSync(paths.status_path_abs) ? JSON.parse(readFileSync(paths.status_path_abs, 'utf8')).state : 'DISPATCHED';
      if (!['RUNNING', 'STARTING', 'DISPATCHED'].includes(task.status)) task.status = 'RUNNING';
      task.updated_at = clock().toISOString();
      return { kind: 'WAITING', task };
    }
    const processResult = JSON.parse(readFileSync(paths.result_path_abs, 'utf8'));
    if (processResult.state !== 'SUCCEEDED') {
      return { kind: 'ERROR', code: processResult.error_code ?? 'AGENT_PROCESS_FAILED', message: processResult.error_message ?? 'Agent process failed', task, process_result: processResult };
    }
    if (task.kind === 'TEST') {
      try {
        const launcher = JSON.parse(readFileSync(paths.launcher_path_abs, 'utf8'));
        if (!processResult.sandbox_attestation) throw Object.assign(new Error('test-agent process completed without Docker sandbox attestation'), { code: 'SANDBOX_ATTESTATION_MISSING' });
        assertSandboxAttestation(processResult.sandbox_attestation, launcher.sandbox_mount_plan);
        task.sandbox_attestation = processResult.sandbox_attestation;
      } catch (error) {
        return { kind: 'ERROR', code: error.code ?? 'SANDBOX_ATTESTATION_INVALID', message: error.message, details: error.details ?? null, task };
      }
    }
    try {
      const accepted = ingestTaskOutput({ projectRoot, task, occurredAt: clock().toISOString(), cycle });
      task.status = 'SUCCEEDED';
      task.result = accepted.value;
      task.output_path_abs = accepted.output_path_abs;
      task.ingestion_receipt_path_abs = accepted.receipt_path_abs;
      task.updated_at = clock().toISOString();
      return { kind: 'SUCCEEDED', task };
    } catch (error) {
      const details = { code: error.code ?? 'AGENT_OUTPUT_INVALID', message: error.message, details: error.details ?? null };
      if ((task.json_regenerations ?? 0) < policy.json_regeneration_retries) {
        task.json_regenerations = (task.json_regenerations ?? 0) + 1;
        task.status = 'REPAIR_READY';
        task.last_error = details;
        task.updated_at = clock().toISOString();
        return { kind: 'JSON_REPAIR', task, error: details };
      }
      return { kind: 'ERROR', task, ...details };
    }
  }

  return { start, reconcile };
}
