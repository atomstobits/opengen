import { operationalError } from './operational-error.js';
import { createEngine, readExecutionScopeConfiguration } from '@media-router/engine';
import { workServerOnce } from './worker-turn.js';
import { readProviderExecutionConfiguration } from './provider-execution.js';
const providerExecutionEnabled = readProviderExecutionConfiguration(process.env);
const executionScope = readExecutionScopeConfiguration(process.env);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the worker.');
const engine = createEngine({
  databaseUrl: process.env.DATABASE_URL,
  providerExecutionEnabled,
  executionScope,
});
await engine.initialize();
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
while (!stopping) {
  try {
    await workServerOnce(engine);
  } catch (error) {
    console.error('Worker iteration failed:', operationalError(error));
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
await engine.close();
