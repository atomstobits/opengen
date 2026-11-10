import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.ENGINE_TEST_PORT ?? 55439);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid ENGINE_TEST_PORT.');
const startupStartedAt = performance.now();
const server = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/@electric-sql/pglite-socket/dist/scripts/server.js'),
    '--db=memory://',
    `--port=${port}`,
    '--host=127.0.0.1',
    '--max-connections=20',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '';
server.stderr.on('data', (chunk) => {
  diagnostics = `${diagnostics}${chunk}`.slice(-3_000);
});

try {
  await new Promise((resolveReady, reject) => {
    let stdout = '';
    const timeout = setTimeout(
      () => reject(new Error(`PGlite startup timed out. ${diagnostics}`)),
      60_000,
    );
    const fail = (code) => {
      clearTimeout(timeout);
      reject(new Error(`PGlite exited before readiness (${code}). ${diagnostics}`));
    };
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', fail);
    server.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-3_000);
      diagnostics = `${diagnostics}${chunk}`.slice(-3_000);
      if (stdout.includes('PGLiteSocketServer listening on')) {
        clearTimeout(timeout);
        server.removeListener('exit', fail);
        resolveReady();
      }
    });
  });
  console.log(
    `PGlite became ready in ${Math.round(performance.now() - startupStartedAt)}ms on ${process.version}.`,
  );
  console.log(
    'Running local PostgreSQL-wire checks against ephemeral PGlite. Real PostgreSQL concurrency must also run in CI.',
  );
  const tests = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--no-file-parallelism',
      ...(process.argv.length > 2
        ? process.argv.slice(2)
        : [
            'tests/engine.test.ts',
            'tests/reconciliation-race.test.ts',
            'tests/engine-adapters.test.ts',
            'tests/accounts.test.ts',
            'tests/mcp-authorization.test.ts',
            'tests/mcp-native-authorization.test.ts',
            'tests/team-consent.test.ts',
            'tests/teams.test.ts',
            'tests/operator.test.ts',
            'tests/events.test.ts',
            'tests/feedback.test.ts',
            'tests/billing-ownership.test.ts',
            'tests/routing-execution.test.ts',
            'tests/payments-integration.test.ts',
            'tests/payments.test.ts',
            'tests/payment-rate-limits.test.ts',
            'tests/payment-concurrency.test.ts',
          ]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MR_DATABASE_POOL_SIZE: '1',
        TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
      },
      stdio: 'inherit',
    },
  );
  const [code] = await once(tests, 'exit');
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5_000);
    timeout.unref();
    await stopped;
    clearTimeout(timeout);
  }
}
