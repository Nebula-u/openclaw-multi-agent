import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function unquote(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

export function loadProjectEnvironment(projectRootInput, { processEnvironment = process.env } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const filePath = join(projectRoot, '.env');
  const fileValues = existsSync(filePath) ? parseDotEnv(readFileSync(filePath, 'utf8')) : {};
  // Explicit process variables win over the project file, which keeps CI and
  // service managers able to override local defaults without editing .env.
  return { ...fileValues, ...processEnvironment };
}

export function integerEnvironment(environment, name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = environment?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
