# Task-Scoped Test Sandbox Design

## Goal

Make every `TEST` task run in an isolated, one-shot Docker container that can access only that task's input, worktree, staged result output, and raw logs.

## Problem

OpenClaw's persistent test-agent sandbox currently mounts only its agent workspace at `/workspace`. The Orchestrator dispatches host-absolute paths under `<project>/runtime`, so the container cannot read the task context or worktree and cannot write the staged result. Replacing the Docker sandbox with host execution would violate the project's mandatory Docker isolation rule.

## Scope

- Add a task-scoped Docker sandbox launcher to the Orchestrator for `TEST` tasks.
- Map host task paths to stable container paths and make those paths explicit in the dispatched context.
- Preserve the existing Docker hardening profile: no network, read-only root filesystem, non-root user, `CAP_DROP=ALL`, and process/CPU/memory limits.
- Validate the task sandbox before an agent is dispatched and collect a host-verified mount attestation.
- Make blocked preflight output ingestible without losing the task's expected `input_commit`.
- Cover the launcher, path translation, and blocked-result handling with automated Node tests.

## Non-goals

- Do not switch test-agent to host execution.
- Do not expose a static mount of all `runtime/worktrees` or `runtime/artifacts` to test-agent.
- Do not change non-TEST Agent sandbox behavior.
- Do not grant network, Docker socket access, host credentials, or broad host filesystem access to the test container.

## Architecture

For every TEST execution, the Orchestrator builds a `TaskSandboxSpec` from the task's canonical host paths. It starts a fresh Docker container using the configured test image, then dispatches the test agent with a container-specific context. The persistent OpenClaw agent sandbox remains restricted to its own workspace; task execution occurs only in the task-scoped container.

| Host source | Container target | Mode |
| --- | --- | --- |
| Attempt input directory | `/task/input` | read-only |
| Assigned worktree | `/task/repo` | read-write |
| Task `.agent-raw` directory | `/task/output` | read-write |
| Task `raw-logs` directory | `/task/raw-logs` | read-write |

The generated container context has two path classes:

- **Execution paths** (`/task/...`) are the only paths test-agent may pass to commands.
- **Identity paths** are canonical host paths and are copied verbatim into result identity fields so the host-side output boundary can validate them. They are never command working directories.

The output directory is prepared with permissions compatible with the configured container UID/GID before launch. The container is removed after result collection, including error and cancellation paths.

## Failure Handling

Before dispatch, the host verifies each mount source is inside the task's authorized roots, exists, has the expected type, and has the required read/write access. Any failure returns a structured `BLOCKED` result without starting test commands.

`BLOCKED` output must retain the task's supplied `input_commit`, even when the worktree cannot be read. The output ingestion boundary accepts this preflight result, records the infrastructure issue, and follows the configured human-decision path rather than regenerating JSON or retrying unchanged infrastructure.

## Portability

All host paths are derived at runtime from `projectRoot`, `runtimeRoot`, and task metadata; no `/home/ubuntu/...` path is embedded in source. Docker invocation uses argument arrays, not shell-concatenated commands. Linux Docker Engine and Windows Docker Desktop are supported provided that Docker bind mounts are available and the test image can be built or obtained.

Installed Agent configuration is regenerated on each target machine by the existing installer, which resolves that machine's project and runtime paths. Machine-local OpenClaw configuration, credentials, sandboxes, artifacts, and containers are not copied between computers.

## Acceptance Criteria

1. A TEST task receives exactly the four task-scoped mounts above; no sibling task worktree or artifact root is mounted.
2. The container retains `network=none`, read-only rootfs, non-root execution, dropped capabilities, and existing resource limits.
3. The agent can read `/task/input`, read/write `/task/repo`, and write `/task/output` and `/task/raw-logs`.
4. The agent cannot write `/` or access an unmounted sibling task path.
5. Host path identity fields remain valid for output ingestion while commands use only container paths.
6. Missing or invalid mount inputs produce one ingestible `BLOCKED` result with the original task `input_commit`; they do not enter JSON regeneration loops.
7. Automated tests cover Linux and Windows command/path construction without requiring a real Docker daemon; a Docker-backed integration test runs when Docker is available.
8. The installer dry-run and installation validation continue to pass, and documentation explains image preparation and cross-machine setup.
