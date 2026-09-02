# Manager–Orchestrator Request Repair Design

## Goal

Make the manager hand a confirmed workflow to the Node Orchestrator with the current request contract, while leaving product requirements to the requirement agent.

## Observed Failure

The manager wrote a legacy StateGraph-shaped request (`schema`, `type`, and `stages`) to the current Node Orchestrator queue. The foreground Orchestrator was healthy, consumed that file, and produced a `MANAGER_REQUEST_SCHEMA_INVALID` receipt. No run was created, so Monitor correctly showed no workflow.

The manager instructions and installed templates were internally inconsistent: `AGENTS.md` required a schema-valid request, `TOOLS.md` still described the removed `.agent-raw/route-plan.json.raw` output, and `templates/manager-request.json` documented only a `DECISION` request. The manager also could not use the documented Node validation command because its package denies `exec`.

## Interaction Boundary

For a feature whose route includes `REQUIREMENTS`, the manager may ask necessary questions to decide the route or obtain user confirmation. It must not produce or present product-level scope, persistence choices, technology choices, acceptance criteria, or a recommended requirements specification as its own analysis. The requirement agent owns that output.

The default feature route remains serial:

`REQUIREMENTS` → `ARCHITECTURE` → `DEVELOPMENT` → `TEST` → `CODE_REVIEW`.

`REQUIREMENTS` has a human approval checkpoint. The route policy—not the manager—maps each stage to its assigned agent, so `REQUIREMENTS` is always dispatched to `requirement-agent`.

## Request Submission

The manager uses only its existing workspace file tools:

1. On confirmation, retrieve the current session identity with `session_status`.
2. Read the installed request-reference template.
3. Write exactly one `CREATE`, `CHANGE`, or `DECISION` JSON object to `.orchestrator/requests/`.
4. Read the known receipt filename from `.orchestrator/receipts/` and report only `ACCEPTED` or `REJECTED` facts.

The Node Orchestrator remains the sole validator, route freezer, and task dispatcher. No worker delegation capability is added to the manager.

## Template and Prompt Contract

The manager workspace contains a current reference for each request kind. The rules name the required fields and route shape explicitly, direct the manager to use the templates, and remove StateGraph and `.agent-raw` language. The manager must not claim that a workflow exists until it has read an `ACCEPTED` receipt.

## Verification

Deterministic tests will verify that the manager reference contains all three request types, that its documented `CREATE` request is accepted by the existing queue processor and produces a run, that the route maps requirements to `requirement-agent`, and that the manager instructions no longer prescribe the obsolete output or unavailable validation command. Existing route-policy and queue tests continue to prove receipt behavior.

## Out of Scope

- Changing the Node Orchestrator queue directory or the Monitor data source.
- Granting the manager `exec`, direct database access, native worker delegation, or development tools.
- Prohibiting all manager clarifying questions for vague feature requests.
