# Agent JSON Workflow Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run three fixed Schema-aware JSON generation cases ten times for every registered Agent contract and preserve all invalid output with actionable diagnostics.

**Architecture:** Replace the old five-case/two-repetition LLM scenario shape with a single explicit 19-schema registry.  Reuse the Gateway client, production JSON ingestion, Runtime Guard, and same-session repair runner; extend the collector to package every invalid attempt and render per-schema 30-run rates.

**Tech Stack:** Node.js ESM, node:test, Ajv through Runtime Guard, OpenClaw Gateway client.

## Global Constraints

- The live matrix is exactly 19 schemas × 3 cases × 10 repetitions = 570 logical runs.
- Initial prompts include the complete JSON Schema and identify the run as a JSON cleaning/retry workflow test.
- A logical run has at most two same-session repair replies; repair turns do not count as new samples.
- Gateway transport errors produce `INCOMPLETE`, are retained, and are excluded from quality denominators.
- Existing unrelated uncommitted files must not be modified.

---

### Task 1: Define the fixed Agent Schema case registry

**Files:**
- Modify: `scripts/agent-json-harness/llm-scenarios.mjs`
- Test: `tests/agent-llm-json-harness.test.mjs`

**Interfaces:**
- Produces: `LLM_SCENARIOS`, each with `schemaFile`, `agentId`, `jsonl`, and exactly three `{ id, topic, requirement, language, variation }` cases.

- [ ] **Step 1: Write failing coverage tests**
- [ ] **Step 2: Run `npm run test:agent-json:offline` and observe the former five-case contract fail**
- [ ] **Step 3: Replace generated case variation with the explicit three-case registry, including `task-run.schema.json`**
- [ ] **Step 4: Run the offline suite and verify the coverage test passes**

### Task 2: Archive every failed attempt and calculate complete rates

**Files:**
- Modify: `scripts/agent-json-harness/collect-llm-failures.mjs`
- Test: `tests/agent-llm-json-harness.test.mjs`

**Interfaces:**
- Produces: `summary.json`, `report.md`, and an attempt-specific evidence folder for every invalid reply.

- [ ] **Step 1: Write failing collector tests for three-by-ten planning, non-final failure packages, and normalized errors**
- [ ] **Step 2: Run the offline suite and observe missing package/rate fields**
- [ ] **Step 3: Add attempt folders, diagnosis records, strict/raw and cleaned pass counters, and `INCOMPLETE` transport handling**
- [ ] **Step 4: Run the offline suite and verify collector behavior**

### Task 3: Add stable command and documentation

**Files:**
- Modify: `package.json`, `scripts/agent-json-harness/collect-llm-failures.mjs`, `docs/llm-json-recovery.md`, `scripts/agent-llm-contract-tests/README.md`
- Test: `tests/agent-llm-json-harness.test.mjs`

**Interfaces:**
- Produces: `npm run agent-json:matrix -- --run-id <id>` with a fixed ten repetitions.

- [ ] **Step 1: Write failing tests for fixed CLI repetitions and test-workflow prompt wording**
- [ ] **Step 2: Run the offline suite and observe the old configurable count/prompt fail**
- [ ] **Step 3: Implement the command and update operational documentation**
- [ ] **Step 4: Run `npm run test:agent-json:offline` and `node scripts/runtime-guard.mjs self-check --project-root .`**
