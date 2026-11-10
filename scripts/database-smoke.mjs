import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Disposable local Compose stack only. No provider calls or production targets.
const root = new URL('../', import.meta.url);
const compose = ['compose', '--env-file', '.env', '-f', 'deploy/compose.yaml', 'exec', '-T', 'db'];
const run = (args, options = {}) =>
  execFileSync('docker', [...compose, ...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const restored = `opengen_restore_${randomUUID().replaceAll('-', '')}`;
const summarySql = `SELECT json_build_object(
  'workspaces',(SELECT count(*) FROM mr_workspaces),
  'jobs',(SELECT count(*) FROM mr_jobs),
  'attempts',(SELECT count(*) FROM mr_attempts),
  'ledger',(SELECT count(*) FROM mr_ledger),
  'available',(SELECT coalesce(sum(available_micros),0) FROM mr_workspaces),
  'reserved',(SELECT coalesce(sum(reserved_micros),0) FROM mr_workspaces));`;
const summary = (database) =>
  JSON.parse(
    run(['psql', '-U', 'opengen', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', summarySql], {
      encoding: 'utf8',
    }),
  );
const original = summary('opengen');
const backup = run(['pg_dump', '-U', 'opengen', '-d', 'opengen', '--format=custom']);
let created = false;
try {
  run(['createdb', '-U', 'opengen', restored]);
  created = true;
  run(
    ['pg_restore', '-U', 'opengen', '-d', restored, '--no-owner', '--no-acl', '--exit-on-error'],
    { input: backup },
  );
  assert.deepEqual(summary(restored), original);
  console.log(
    'Disposable database dump/restore passed: core table counts and balance totals match.',
  );
} finally {
  if (created) run(['dropdb', '-U', 'opengen', restored]);
  backup.fill(0);
}
