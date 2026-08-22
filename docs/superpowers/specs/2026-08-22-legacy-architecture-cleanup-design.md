# Legacy Architecture Cleanup Design

## Problem

The active runtime is Node Orchestrator + SQLite Control Kernel, but an existing Kernel created during the retired LangGraph era still has `runs.langgraph_thread_id TEXT NOT NULL`. Current CREATE inserts intentionally omit that column, so otherwise valid Manager requests are rejected. Separately, a dead foreground Orchestrator can leave a status file that is still reported as `RUNNING`. Several active documents still describe native Manager-to-worker delegation, an unsandboxed test Agent, or PostgreSQL Kernel writes.

## Decisions

### SQLite migration

Use `PRAGMA user_version` as the schema version without adding a ninth fact table. Writable Kernel open performs an idempotent migration before returning the database facade. Version 1 removes only the known legacy `runs.langgraph_thread_id` column in a transaction, preserves all rows and foreign-key relationships, executes the canonical schema, and records `user_version=1`. Unknown schema drift fails closed.

Read-only status never mutates the database. It reports the current schema version and known migration issues so an old database cannot appear healthy merely because all eight table names exist.

### Foreground service status

Published service status remains the process-owned observation file. Readers reconcile an active-looking status with process liveness and heartbeat age. When the recorded process is gone or the heartbeat is older than the bounded threshold, the returned state is `STALE` and includes the recorded state and reason. A stop request accepts only a live `STARTING`, `RUNNING`, or `DRAINING` instance.

### Documentation

Active integration documents describe the current division of responsibility: Manager writes schema-valid requests, Node Orchestrator dispatches fixed workers, SQLite stores workflow facts, and test-agent runs in the configured Docker sandbox. Historical plans, ADR bodies, reports, CHANGELOG entries, `.stategraph` ignore containment, and current `.agent-raw` ingestion remain intact.

## Safety and verification

The migration never deletes the Kernel database. Tests construct a legacy database containing a real run, migrate it, and prove the row remains writable without the old column. Service tests use the real current process for live status and a non-existent PID for stale status. Final verification includes the full test suite, install dry-run, install validation, Git whitespace checks, a timestamped backup of the live Kernel, live schema application, and a read-only status check.
