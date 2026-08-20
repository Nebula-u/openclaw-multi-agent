#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { ingestJsonText, JsonIngestionError } from './json-ingestion.mjs';

try {
  const raw = readFileSync(0, 'utf8');
  const ingestion = ingestJsonText(raw, { jsonl: process.argv.includes('--jsonl') });
  process.stdout.write(`${JSON.stringify({ ok: true, value: ingestion.value, raw_sha256: ingestion.raw_sha256,
    cleaned_sha256: ingestion.cleaned_sha256, transformations: ingestion.transformations })}\n`);
} catch (error) {
  const diagnostic = error instanceof JsonIngestionError ? error.diagnostic : 'JSON_PARSE_ERROR';
  process.stdout.write(`${JSON.stringify({ ok: false, diagnostic, message: error.message })}\n`);
  process.exitCode = 1;
}
