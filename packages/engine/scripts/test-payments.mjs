// Serial fixture-only PostgreSQL-wire run; native lock schedules run separately in CI.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = 55443;
const server = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/@electric-sql/pglite-socket/dist/scripts/server.js'),
    '--db=memory://',
    `--port=${port}`,
    '--host=127.0.0.1',
    '--max-connections=10',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '';
server.stderr.on('data', (chunk) => {
  diagnostics = `${diagnostics}${chunk}`.slice(-3000);
});
try {
  await new Promise((ready, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`PGlite startup timed out: ${diagnostics}`)),
      45000,
    );
    server.once('error', reject);
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`PGlite exited (${code}): ${diagnostics}`));
    });
    server.stdout.on('data', (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-3000);
      if (diagnostics.includes('PGLiteSocketServer listening on')) {
        clearTimeout(timeout);
        ready();
      }
    });
  });
  const tests = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--no-file-parallelism',
      'tests/payments.test.ts',
      'tests/payment-rate-limits.test.ts',
      'tests/payment-api.test.ts',
      'tests/payment-concurrency.test.ts',
      'tests/payments-ui.test.ts',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
        TEST_NATIVE_POSTGRES: '0',
      },
      stdio: 'inherit',
    },
  );
  const [code] = await once(tests, 'exit');
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
    timeout.unref();
    await stopped;
    clearTimeout(timeout);
  }
}
