# Task-Scoped Test Sandbox Design

## Goal

Make every `TEST` task run in an isolated Docker session workspace containing only that task's staged input, Git worktree copy, result output, and raw logs.

## Problem

OpenClaw's test-agent sandbox mounts only its agent workspace at `/workspace`. Its `openclaw agent` CLI does not support per-run Docker bind overrides. The Orchestrator currently dispatches host-absolute paths under `<project>/runtime`, so the container cannot read the task context or worktree and cannot write the staged result. Replacing the Docker sandbox with host execution would violate the project's mandatory Docker isolation rule.

## Scope

- Stage every TEST task's immutable input and an isolated Git worktree copy inside the OpenClaw session workspace mounted at `/workspace`.
- Map the staged task layout to stable container paths and make those paths explicit in the dispatched context.
- Preserve the existing Docker hardening profile: no network, read-only root filesystem, non-root user, `CAP_DROP=ALL`, and process/CPU/memory limits.
- Validate the staged task workspace before an agent is dispatched and collect a host-verified staging attestation.
- Make blocked preflight output ingestible without losing the task's expected `input_commit`.
- Cover the launcher, path translation, and blocked-result handling with automated Node tests.

## Non-goals

- Do not switch test-agent to host execution.
- Do not expose a static mount of all `runtime/worktrees` or `runtime/artifacts` to test-agent.
- Do not change non-TEST Agent sandbox behavior.
- Do not grant network, Docker socket access, host credentials, or broad host filesystem access to the test container.

## Architecture

OpenClaw exposes a shared agent workspace when `workspaceAccess` is `rw`; it does not expose a per-session writable workspace. Therefore the Orchestrator reserves one OS-backed global TEST staging lease before every TEST execution, deletes any previous staging directory, and recreates the task layout below the dedicated test-agent workspace. It then stages an immutable input copy and creates a task-local Git clone before dispatching test-agent. The kernel-owned lease prevents concurrent TEST tasks and is released automatically if the Orchestrator process dies, so stale receipt-file recovery is unnecessary. The writable workspace contains one task's files only. The Orchestrator removes the staging directory and releases the lease after every completion, error, and cancellation path.

| Staged session-workspace source | Container target | Mode |
| --- | --- | --- |
| Immutable attempt input copy | `/workspace/.task-sandbox/input` | read-only after staging |
| Task-local Git clone | `/workspace/.task-sandbox/repo` | read-write |
| Staged raw result directory | `/workspace/.task-sandbox/output` | read-write |
| Staged raw-log directory | `/workspace/.task-sandbox/raw-logs` | read-write |

The generated container context has two path classes:

- **Execution paths** (`/workspace/.task-sandbox/...`) are the only paths test-agent may pass to commands.
- **Identity paths** are canonical host paths and are copied verbatim into result identity fields so the host-side output boundary can validate them. They are never command working directories.

The staging directory is prepared with permissions compatible with the configured container UID/GID. Before staging, the host verifies and restores the immutable test-agent workspace files from their managed source. After the agent finishes, the host copies only the staged result and raw logs to the canonical task artifact root, validates them, removes the staging directory, restores the immutable workspace files, and releases the TEST staging lease. A test-agent Git commit is transferred to the canonical assigned worktree only through an explicitly validated patch/commit handoff; it is never exposed as a host bind mount.

## Failure Handling

Before dispatch, the host verifies the TEST staging lease, dedicated workspace, input copy, task-local Git clone, output directory, raw-log directory, and workspace-file hashes. Any failure returns a structured `BLOCKED` result without starting test commands.

`BLOCKED` output must retain the task's supplied `input_commit`, even when the worktree cannot be read. The output ingestion boundary accepts this preflight result, records the infrastructure issue, and follows the configured human-decision path rather than regenerating JSON or retrying unchanged infrastructure.

## Portability

All host paths are derived at runtime from `projectRoot`, task metadata, and OpenClaw's reported session workspace; no `/home/ubuntu/...` path is embedded in source. Git and OpenClaw invocation use argument arrays, not shell-concatenated commands. TEST execution currently requires a native Linux host and Linux Docker Engine. Native Windows fails closed because Docker Desktop's single writable workspace bind cannot enforce the staged input subtree as read-only. Windows support requires a future OpenClaw per-run read-only submount (or an equivalent enforceable boundary); path-construction tests remain cross-platform so container paths stay POSIX.

Installed Agent configuration is regenerated on each target machine by the existing installer, which resolves that machine's project and runtime paths. Machine-local OpenClaw configuration, credentials, sandboxes, artifacts, and containers are not copied between computers.

## Acceptance Criteria

1. A TEST staging lease permits one TEST execution at a time. Its dedicated writable workspace contains only its staged input, task-local repository clone, staged output, and staged raw logs; no sibling task worktree or artifact root is present.
2. The container retains `network=none`, read-only rootfs, non-root execution, dropped capabilities, and existing resource limits.
3. The agent can read `/workspace/.task-sandbox/input`, read/write `/workspace/.task-sandbox/repo`, and write `/workspace/.task-sandbox/output` and `/workspace/.task-sandbox/raw-logs` on the supported native Linux host.
4. The agent cannot write `/` or access a host runtime path or sibling task staging path.
5. Host path identity fields remain valid for output ingestion while commands use only container paths.
6. Missing or invalid mount inputs produce one ingestible `BLOCKED` result with the original task `input_commit`; they do not enter JSON regeneration loops.
7. Automated tests cover Linux and Windows command/path construction, verify native Windows staging fails closed, and run a Docker-backed integration test when Linux Docker Engine is available.
8. The installer dry-run and installation validation continue to pass, and documentation explains image preparation and cross-machine setup.
