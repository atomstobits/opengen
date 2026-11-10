import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.GOVERNANCE_TEST_PORT ?? 55463);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test port.');
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
server.stderr.on('data', (c) => {
  diagnostics = `${diagnostics}${c}`.slice(-2000);
});
try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`PGlite startup timeout: ${diagnostics}`)),
      120000,
    );
    server.once('error', reject);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`PGlite exited ${code}: ${diagnostics}`));
    });
    server.stdout.on('data', (c) => {
      diagnostics = `${diagnostics}${c}`.slice(-2000);
      if (diagnostics.includes('PGLiteSocketServer listening on')) {
        clearTimeout(timer);
        ready();
      }
    });
  });
  // Apply proposals only to this disposable fixture database. Production loader
  // and numbered migration remain exclusively integration-owned.
  const fixtureDatabaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const setup = new Pool({ connectionString: fixtureDatabaseUrl, max: 1 });
  try {
    await setup.query(
      'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (let i = 1; i <= 12; i++) {
      const name = `${String(i).padStart(3, '0')}.sql`;
      const migration = await readFile(resolve(root, `packages/engine/migrations/${name}`), 'utf8');
      await setup.query(migration);
      await setup.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
        name,
        createHash('sha256').update(migration).digest('hex'),
      ]);
    }
    for (const file of (await readdir(resolve(root, 'packages/engine/schema-proposals')))
      .filter((file) => file.startsWith('governance-') && file.endsWith('.sql'))
      .sort())
      await setup.query(
        await readFile(resolve(root, 'packages/engine/schema-proposals', file), 'utf8'),
      );
  } finally {
    await setup.end();
  }
  const files = process.argv.slice(2);
  const tests = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--no-file-parallelism',
      ...(files.length
        ? files
        : [
            'tests/key-budgets.test.ts',
            'tests/account-governance.test.ts',
            'tests/governance-admission.test.ts',
            'tests/governance-adapters.test.ts',
            'tests/governance-authority.test.ts',
            'tests/routing-governance.test.ts',
            'tests/governance-ui.test.ts',
          ]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TEST_NATIVE_POSTGRES: '0',
        TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
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
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    timer.unref();
    await stopped;
    clearTimeout(timer);
  }
}
