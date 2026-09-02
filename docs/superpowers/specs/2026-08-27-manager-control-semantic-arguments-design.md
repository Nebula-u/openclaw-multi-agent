# Manager Control Semantic Arguments Design

## Goal

Make the Windows Manager control entrypoint usable from its constrained PowerShell session without passing JSON through the `manager-control.cmd` batch wrapper.

## Scope

This change affects only the `manager-control` command protocol and the Manager instructions that invoke it.

- Do not change any model's maximum-output-token setting.
- Preserve the user's current OpenClaw `low` thinking configuration; this change does not modify model or thinking configuration.
- Do not introduce a maximum number of failed diagnostic attempts.
- Do not expand the Manager allowlist beyond the installed `manager-control` entrypoint.
- Do not give the Manager arbitrary shell, Node, PowerShell, Git, or file-input privileges.

## Problem

The Manager is only allowed to invoke `manager-control.cmd`. On Windows, inline JSON such as `--project-json '{"mode":"new","name":"todo list"}'` crosses PowerShell, the batch file's `%*` expansion, and a Node invocation. Embedded quotes are not preserved reliably, so valid input reaches the CLI as invalid JSON. The same structural problem exists for `--authorization-json`.

The current unit tests call the JavaScript `run(argv)` function directly. They validate the CLI parser but do not exercise the deployed Windows `.cmd` wrapper and therefore cannot detect this regression.

## Design

### Public command protocol

Add quote-free semantic parameters to the existing command actions:

```text
manager-control ensure \
  --workflow-id <workflow-id> \
  --project-name <project-name> \
  --project-mode new|remote \
  [--remote-url <https-url>]

manager-control orchestrator-approve \
  --workflow-id <workflow-id> \
  --manager-session-id <manager-session-id> \
  --manager-session-key <manager-session-key> \
  --decision-id <decision-id> \
  --choice <choice> \
  --authorization-summary <explicit-user-authorization> \
  [--notes <notes>]
```

`ensure` constructs `{ mode, name, remote_url? }` in the CLI. `orchestrator-approve` constructs the authorization object in the CLI with a fixed `actor` value owned by the Manager-control boundary and the exact user-provided summary as its message. The control service remains the authority that validates projects, session bindings, pending decisions, and allowed choices.

The new forms reject invalid combinations before any project or decision side effect:

- `new` must not include `--remote-url`.
- `remote` must include `--remote-url`.
- any other project mode is invalid.
- authorization summary must be non-empty.

### Compatibility and security

The legacy `--project-json` and `--authorization-json` forms are removed from the Manager-facing command grammar rather than retained as an alternate route. This makes the safe interface unambiguous and ensures future Manager instructions cannot accidentally reintroduce the Windows quoting path.

All other supported actions retain their existing argument protocol. The `.cmd` wrapper stays the sole allowlisted executable. No caller-supplied JSON file path, encoded command, or arbitrary payload is added.

### Manager behavior

Update `agents/manager-agent/workspace/AGENTS.md` and `TOOLS.md` to require semantic arguments for project registration and approval. The Manager must report a concise factual status after a tool error, but receives no attempt-count stop rule.

### Tests

1. Update direct CLI tests for successful semantic `ensure` and semantic approval.
2. Test invalid mode/remote combinations and an empty authorization summary.
3. Add a Windows-only integration test that launches the real `manager-control.cmd` through PowerShell with a project name containing spaces. It must emit a successful JSON registration response. The test is skipped off Windows.
4. Keep tests that assert unsupported parameters are rejected.

### Documentation and installation

Document the new invocation form where Manager control is described. Because the Manager workspace and deployed runtime bundle change, users must run the normal Agent update command after source validation:

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

The normal update does not require stopping the OpenClaw Gateway.

## Acceptance Criteria

- A Windows PowerShell invocation of `manager-control.cmd ensure` with a multi-word project name succeeds without inline JSON.
- A Manager approval can be submitted without inline JSON.
- Invalid semantic parameter combinations fail before side effects.
- Existing resolve, fetch, and status actions remain unchanged.
- The Manager workspace contains no instruction to use `--project-json` or `--authorization-json`.
- The focused Manager-control tests and the repository's applicable validation suite pass.
