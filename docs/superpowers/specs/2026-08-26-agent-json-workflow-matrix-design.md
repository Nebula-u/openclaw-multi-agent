# Agent JSON Workflow Matrix Design

## Goal

Provide a repeatable Gateway-based evaluation of every JSON Schema emitted by
an Agent.  Each schema has three version-controlled business requests, each
request runs ten independent times, and every response follows the same JSON
ingestion, validation, repair, and evidence-retention path.

## Scope

The matrix covers the 19 schemas in `CONTRACT_SCENARIOS`: they are the only
contracts mapped to a registered Agent.  The remaining nine schemas are host
or control-plane projections and stay covered by deterministic offline tests;
they must never create LLM calls merely to inflate the matrix.

`task-run.schema.json` is included in the live matrix.  It is currently
registered for the manager Agent but absent from the older LLM scenario list.

## Matrix and execution rules

* Each Agent schema owns exactly three fixed cases: basic, conservative
  alternate branch, and nested/collection-rich branch.
* Every case runs exactly ten times.  One logical run may have one initial
  reply and up to two repair replies in its own Gateway session.
* The initial prompt includes the complete schema and explicitly says that it
  is a JSON generation-and-cleaning workflow test.  It prohibits tool calls,
  file access, analysis, Markdown, and any text other than the requested
  JSON/JSONL.
* Runtime Guard validation is preceded by the production JSON ingestion
  routine.  A repair reply receives only compact validation diagnostics and
  stays in the same session.
* Transport failures are recorded but excluded from quality-rate denominators;
  any such failure marks the run `INCOMPLETE` and causes a nonzero process exit.

## Evidence and reporting

Every invalid reply is retained even if a later repair succeeds.  Its evidence
folder contains raw uncleaned reply text, cleaned reply when available,
initial/repair prompt, ingestion metadata, guard errors, and normalized Chinese
diagnosis.  The report gives per-schema counts for strict raw first passes,
post-cleaning first passes, repair successes, final passes, transport failures,
and error categories.  A schema's complete quality denominator is 30.

## Deterministic coverage

Offline tests verify that all Agent schemas are covered exactly once, each has
three stable requests, the matrix is always 570 logical runs, repair turns
reuse the session, errors are archived per attempt, and the cleanup layer
accepts permitted BOM/fence/wrapper variants without changing the validated
payload.
