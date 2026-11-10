import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Job } from '@media-router/contracts';
import type { Engine } from '../../packages/engine/src/index.js';

/** Every engine/status-pool connection inherits its schema, including restarts and races. */
export async function isolatedEngineDatabase(databaseUrl: string, prefix = 'engine_fixture') {
  if (!/^[a-z][a-z0-9_]{0,24}$/.test(prefix)) throw new Error('Invalid fixture schema prefix.');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const scoped = new URL(databaseUrl);
  const previous = scoped.searchParams.get('options');
  scoped.searchParams.set('options', `${previous ?? ''} -c search_path=${schema}`.trim());
  let closed = false;
  return {
    schema,
    databaseUrl: scoped.href,
    bind(engine: Engine) {
      // PGlite's wire shim ignores PostgreSQL startup options. Native CI must
      // prove URL inheritance without this fallback. In the shim, initialize
      // EVERY new main/status connection before the pool can hand it out.
      if (process.env.TEST_NATIVE_POSTGRES !== '1') {
        const statusPool = (engine as unknown as { statusPool: Pool }).statusPool;
        for (const pool of [engine.pool, statusPool]) {
          const previous = pool.options.onConnect;
          pool.options.onConnect = async (client) => {
            await previous?.(client);
            await client.query(`SET search_path TO ${schema}`);
          };
        }
      }
      return engine;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await admin.query('SET search_path TO public');
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Drain only the observed original job through real worker steps; never resubmit or settle directly. */
export async function workUntilJob(
  engine: Engine,
  workspaceId: string,
  jobId: string,
  matches: (job: Job) => boolean,
  maxSteps = 12,
): Promise<Job> {
  for (let step = 0; step <= maxSteps; step++) {
    const job = await engine.getJob(workspaceId, jobId);
    if (!job) throw new Error('The fixture job disappeared.');
    if (matches(job)) return job;
    if (step === maxSteps || !(await engine.workOnce())) break;
  }
  throw new Error(
    'The original fixture job did not reach its expected phase within bounded due work.',
  );
}
