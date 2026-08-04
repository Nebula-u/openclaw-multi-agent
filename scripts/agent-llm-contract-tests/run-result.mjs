import { runContractTest } from './run-contract.mjs';
runContractTest({ schemaFile: 'result.schema.json' }).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
