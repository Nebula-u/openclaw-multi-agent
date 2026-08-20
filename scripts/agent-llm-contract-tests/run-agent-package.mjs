import { runContractTest } from './run-contract.mjs';
runContractTest({ schemaFile: 'agent-package.schema.json' }).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
