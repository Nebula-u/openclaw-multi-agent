# Local TEST Attestation Contract Design

## Goal

Prevent an unsandboxed Windows TEST result from being rejected after correctly
reporting `UNSANDBOXED_LOCAL` because it carries an agent-authored placeholder
attestation object.

## Decision

Keep the output boundary fail-closed.  A TEST task dispatched with local host
paths must output both `"isolation_mode": "UNSANDBOXED_LOCAL"` and
`"sandbox_attestation": null`.  The agent must not omit the field or replace
it with an object such as `{ "sandbox_type": "none" }`.

The orchestrator task message and the test-agent workspace instructions will
state this exact JSON contract.  The existing ingestion validation remains the
authority and is not relaxed or normalised.

## Verification

Tests will assert the local task message contains the exact null-attestation
requirement and that local output with a non-null attestation is rejected while
the null form continues to be accepted.
