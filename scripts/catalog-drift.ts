import { runDriftCli } from '../packages/catalog/src/maintenance/drift-cli.js';

process.exitCode = await runDriftCli(process.argv.slice(2), console.log, console.error);
