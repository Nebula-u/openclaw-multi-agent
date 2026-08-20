import { runContractTest } from './run-contract.mjs';
runContractTest({ schemaFile: 'approval-assessment.schema.json' }).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
