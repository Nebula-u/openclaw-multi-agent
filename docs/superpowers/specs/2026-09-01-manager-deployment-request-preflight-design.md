# Manager Deployment Request Preflight Design

## Goal

Prevent schema-invalid Manager deployment requests from using the formal Orchestrator request queue as a trial-and-error validator.

## Decisions

1. Keep the current Manager request and route schemas unchanged.
2. Add a dedicated deployment CREATE reference template with the complete deployment metadata, risk flags, and two RELEASE phases.
3. Require Manager to write confirmed CREATE/CHANGE requests to a bounded draft directory before formal submission.
4. Add bounded Manager-control validation and submission actions. They reuse the existing authoritative `orchestrator-cli validate-request` command; Manager-control does not maintain another schema implementation.
5. Bind validation to submission with SHA-256. Submission rechecks the current draft hash, reruns authoritative validation, and atomically publishes the same bytes to the formal request queue.

## Manager Workflow

For a request without deployment, Manager reads `templates/manager-request.json`. For a request that asks to deploy, publish, go live, run on the server, or provide a public URL, Manager reads `templates/manager-request.deploy.json`.

After the user confirms the route, Manager writes the populated request to:

```text
.orchestrator/drafts/<request-file>.json
```

Manager then invokes:

```text
manager-control orchestrator-validate-request --draft-file <request-file>.json
```

Validation returns the parsed request identity and `input_sha256`. A validation failure is not a formal submission: Manager may repair the same draft and retain its request ID. After validation succeeds, Manager invokes:

```text
manager-control orchestrator-submit-request --draft-file <request-file>.json --expected-sha256 <validated-sha256>
```

Submission rereads the draft, compares its SHA-256, reruns the same validator, refuses to overwrite an existing formal request or receipt, and atomically writes the validated bytes to `.orchestrator/requests/`. Only after this action may Manager wait for and interpret a formal receipt.

## Deployment Template Invariants

The deployment template encodes the following structure directly:

- `manager_delivery` defaults to `null`.
- `risk_flags` contains `external_side_effect`, `manual_acceptance`, and `release_risk`.
- `deployment` contains only `base_url` and `project_id`.
- The route contains two distinct RELEASE steps.
- PREFLIGHT uses `kind: "RELEASE"`, `release_phase: "PREFLIGHT"`, and requires human approval afterward.
- DEPLOY uses `kind: "RELEASE"`, `release_phase: "DEPLOY"`, and has no route approval afterward.
- The template never uses `RELEASE/PREFLIGHT` or `RELEASE/DEPLOY` as a literal `kind`.

## Controlled Boundary

Manager-control accepts a draft basename, not an arbitrary path. It resolves the name under the installed Manager workspace draft directory and rejects absolute paths, separators, traversal, non-JSON names, symbolic links, hard-linked files, and non-regular files.

The installed project root is read from `runtime/control/install-manifest.json`. The manifest, authoritative CLI entrypoint, draft directory, and formal request directory must resolve to regular paths within their expected roots. The validator is invoked with `process.execPath` and an argument array with `shell: false`; no user-controlled command text is evaluated.

Validation errors preserve the current Orchestrator error code, message, and structured details. Successful validation includes the draft SHA-256. Submission requires that SHA and fails closed if the file changed.

## Installation

Windows and Linux installers create the Manager `.orchestrator/drafts`, `.orchestrator/requests`, and `.orchestrator/receipts` directories. Existing whole-directory copies already deploy the new template and Manager-control source, so installer parameters do not change.

Install validation must confirm that the deployment template, Manager rules, draft directories, and bounded actions are present after installation.

## Tests

Tests cover:

- a populated deployment template passes authoritative request and route validation;
- the template includes all deployment invariants;
- invalid drafts never enter the formal queue;
- validation returns all current schema details;
- validation and submission reject traversal, symbolic links, hard links, and existing targets;
- SHA mismatch prevents submission;
- submission reruns validation and publishes the exact validated bytes;
- runtime bundle and Linux/Windows installation include the new behavior;
- Manager instructions require the deployment template and the draft-validation-submit lifecycle.

## Out of Scope

- Changing Manager, route, or release schemas;
- adding automatic LLM JSON regeneration for Manager requests;
- changing Worker result regeneration;
- changing Release execution or approval semantics;
- changing installer command-line parameters.
