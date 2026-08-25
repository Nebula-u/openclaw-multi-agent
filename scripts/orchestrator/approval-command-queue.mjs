import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

function rootFor(projectRoot, runtimeRoot = null) { return join(resolve(runtimeRoot ?? join(resolve(projectRoot), 'runtime')), 'orchestrator', 'approval-commands'); }

function validator(contractsRoot) {
  const requested = join(resolve(contractsRoot), 'contracts', 'approval-command.schema.json');
  const bundled = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'contracts', 'approval-command.schema.json');
  const schema = JSON.parse(readFileSync(existsSync(requested) ? requested : bundled, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv);
  return ajv.compile(schema);
}

function assertFileName(name) {
  if (!/^CMD-[A-Za-z0-9][A-Za-z0-9-]*\.json$/u.test(name)) {
    throw Object.assign(new Error('approval command filename is invalid'), { code: 'APPROVAL_COMMAND_FILENAME_INVALID' });
  }
}

export function createApprovalCommandQueue({ projectRoot: projectRootInput, runtimeRoot = null, contractsRoot = null, resolve: resolveCommand = null } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const root = rootFor(projectRoot, runtimeRoot); const commands = join(root, 'commands'); const receipts = join(root, 'receipts');
  mkdirSync(commands, { recursive: true }); mkdirSync(receipts, { recursive: true });
  const validate = validator(contractsRoot ?? projectRoot);

  function enqueue(command) {
    if (!validate(command)) {
      throw Object.assign(new Error('approval command failed JSON Schema validation'), { code: 'APPROVAL_COMMAND_SCHEMA_INVALID', details: { errors: structuredClone(validate.errors ?? []) } });
    }
    const commandId = String(command?.command_id ?? '');
    if (!/^CMD-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(commandId)) {
      throw Object.assign(new Error('approval command ID is invalid'), { code: 'APPROVAL_COMMAND_ID_INVALID' });
    }
    const path = join(commands, `${commandId}.json`);
    if (!existsSync(path)) atomicWriteJson(path, command);
    return { command_id: commandId, status: 'QUEUED' };
  }

  function receiptPath(name) { assertFileName(name); return join(receipts, `${name.slice(0, -5)}.receipt.json`); }
  function readReceipt(name) {
    const path = receiptPath(name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  async function processFile(name) {
    assertFileName(name);
    const existing = readReceipt(name); if (existing) return existing;
    const path = join(commands, name);
    let command = null;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('approval command must be a regular non-symlink file'), { code: 'APPROVAL_COMMAND_UNSAFE' });
      command = JSON.parse(readFileSync(path, 'utf8'));
      if (!validate(command)) throw Object.assign(new Error('approval command failed JSON Schema validation'), { code: 'APPROVAL_COMMAND_SCHEMA_INVALID', details: { errors: structuredClone(validate.errors ?? []) } });
      if (typeof resolveCommand !== 'function') throw Object.assign(new Error('approval command resolution is unavailable'), { code: 'APPROVAL_COMMAND_RESOLVER_MISSING' });
      const result = await resolveCommand(command);
      const receipt = { schema_version: 1, command_id: command.command_id, status: 'ACCEPTED', processed_at: new Date().toISOString(), result };
      atomicWriteJson(receiptPath(name), receipt); return receipt;
    } catch (error) {
      const receipt = { schema_version: 1, command_id: command?.command_id ?? name.slice(0, -5), status: 'REJECTED', processed_at: new Date().toISOString(),
        error: { code: error.code ?? 'APPROVAL_COMMAND_FAILED', message: error.message, details: error.details ?? null } };
      atomicWriteJson(receiptPath(name), receipt); return receipt;
    }
  }

  async function scan() {
    const output = [];
    for (const name of readdirSync(commands).filter((value) => /^CMD-[A-Za-z0-9][A-Za-z0-9-]*\.json$/u.test(value)).sort()) output.push(await processFile(name));
    return output;
  }

  return { root, commands, receipts, enqueue, readReceipt, processFile, scan };
}
