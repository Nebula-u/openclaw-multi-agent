import { runContractTest } from './run-contract.mjs';
runContractTest({ schemaFile: 'component-build-result.schema.json' }).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
