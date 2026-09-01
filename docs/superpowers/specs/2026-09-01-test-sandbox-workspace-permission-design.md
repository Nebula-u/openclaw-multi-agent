# TEST Sandbox Workspace Traversal Design

## Goal

Allow the configured non-root TEST container user to reach the dedicated staged task directory when the installed test-agent workspace was created with mode `0700`.

## Scope

The orchestrator will normalize only the test-agent workspace directory before creating `.task-sandbox`. It will preserve the existing owner and group and add only the other-user read and execute bits. Thus a `0700` workspace becomes `0705`; no write permission is granted to the container user at the workspace root.

The existing staging layout remains unchanged: only `.task-sandbox/repo`, `.task-sandbox/output`, and `.task-sandbox/raw-logs` are writable for the container. Immutable input and all Docker hardening settings remain unchanged.

## Failure Handling

If the host cannot read the workspace mode or apply the minimal traversal permission, preparation fails closed with a dedicated sandbox error. It must not dispatch an unsandboxed fallback.

## Regression Coverage

Add an integration test using the configured Docker image and its default non-root user. It starts from a `0700` workspace, prepares staging, and verifies that the container can read staged input and write only to the allowed staged directories. Before the production change this test fails with `Permission denied`.

## Non-goals

- Do not change Docker image, user, network, read-only root filesystem, capabilities, CPU, memory, or PID limits.
- Do not change global workspace ownership or grant write access outside the staged directories.
- Do not rerun, alter, or approve the currently waiting workflow.
