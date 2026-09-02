# Orchestrator Approval Control Design

## Goal

Allow a local user to resolve a pending workflow approval from Monitor, let the Orchestrator apply that decision and notify the originating Manager Session, and give `manager-agent` a bounded way to read the exact pending approval and submit a decision.

## Scope

- Add a simple Monitor approval UI with one button per current approval option.
- Monitor writes a small approval command into a durable runtime inbox; it never writes the SQLite Kernel.
- The foreground Orchestrator is the only component that consumes the command, resolves the approval, advances the workflow, and emits the Manager notification.
- Extend the existing fixed `manager-control` executable with `orchestrator-status` and `orchestrator-approve` actions.
- Package those actions through the existing runtime bundle and installer, so a cloned repository works after the documented install command.

## Non-goals

- No user accounts, CSRF tokens, signed commands, separate control port, or remote approval API.
- No direct Monitor write access to SQLite.
- No new arbitrary shell, Node, Git, PowerShell, or cross-Agent permissions.
- No changes to worker Agent privileges.

## Data flow

```text
Monitor button
  -> POST /api/approvals/resolve
  -> runtime/orchestrator/approval-commands/<command>.json
  -> foreground Orchestrator poll
  -> SQLite approval + workflow transition
  -> notification outbox
  -> originating Manager Session
```

The Monitor POST response means only that the command was queued. The authoritative result is the command receipt written by the Orchestrator and the refreshed Kernel snapshot.

## Minimal command contract

Each command contains `command_id`, `workflow_id`, `run_id`, `task_id`, `decision_id`, `choice`, `actor`, `notes`, and `submitted_at`. The Monitor supplies the current identifiers and the selected option. The UI actor is the fixed local value `human:monitor`.

The Orchestrator verifies only the integrity needed to prevent an incorrect decision: the command shape, a still-pending approval, exact workflow/run/task ownership, and membership of `choice` in the approval options. It writes an ACCEPTED or REJECTED receipt using the same command id. Repeated commands cannot resolve an approval twice because the repository only resolves rows in `PENDING` state.

## Orchestrator behavior

The command processor runs at the start of each `tickAll` call. An accepted command uses a shared decision-resolution path with the Manager DECISION request flow. That path resolves the approval, changes the run/task state, queues `HUMAN_APPROVAL_RESOLVED`, and lets normal notification delivery send the update to the original Manager Session. The resumed workflow becomes eligible for subsequent ticks.

## Monitor behavior

`pending_approval.request.options` is the source of the button list. The UI sends the selected `option_id`, disables the buttons while submitting, then displays the queued command id. It polls a simple command-receipt endpoint until the Orchestrator accepts or rejects the command, and the existing workflow stream refreshes the workflow state.

## Manager tool behavior

The current fixed allowlisted `manager-control` executable gains two semantic actions:

- `orchestrator-status`: read-only, session-bound lookup of the workflow, pending approval, allowed options, and recent decision receipt.
- `orchestrator-approve`: requires the current Manager session binding and an explicit human authorization summary, then writes a normal Manager `DECISION` request with the exact pending decision id returned by state lookup.

The tool is packaged inside the existing `manager-control` runtime tree, keeping the host exec allowlist at one fixed executable. Manager instructions require a state lookup before creating a decision and require reporting a rejected receipt instead of claiming success.

## Verification

Tests cover command validation and idempotency, pending-approval scope and option checks, Manager notification delivery, Monitor HTTP/UI behavior, Manager-control state and decision actions, runtime bundle contents, and installer allowlist preservation. The full repository test suite plus both installer validation scripts are the release checks.

## Installed Agent update

This change modifies the Manager workspace and its runtime control bundle. Existing installations need a normal Agent update after source verification:

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

No Gateway stop is required for this ordinary update.
