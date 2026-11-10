import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureModule = new URL('./governance-fixture.ts', import.meta.url).href;
const budgetModule = new URL('../packages/engine/src/key-budgets.ts', import.meta.url).href;

describe.skipIf(!databaseUrl)('key budget calendar dates across host timezones', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'preserves the original UTC month through admission, replay and late settlement in %s',
    async (timezone) => {
      // A child sets only its own timezone and creates its own disposable schema.
      // Exercise the real pg DATE decoder and SQL, without changing the parent
      // process/global parser or pretending PGlite proves native contention.
      const { stdout } = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
          import { governanceFixture } from ${JSON.stringify(fixtureModule)};
          import { KeyBudgetStore } from ${JSON.stringify(budgetModule)};
          const f = await governanceFixture();
          let now = new Date('2026-01-31T23:59:59Z');
          const store = new KeyBudgetStore(() => now);
          try {
            await f.tx(c => store.setCapInTransaction(c, f.workspaceId, f.key.id, 100));
            let jobId;
            const reserve = () => f.tx(c => store.reserveInTransaction(c, {
              workspaceId: f.workspaceId, jobId, keyId: f.key.id,
              billing: 'managed', reservedMicros: 80,
            }));
            const admitted = await f.tx(async c => {
              jobId = await f.job(c, 80);
              return store.reserveInTransaction(c, {
                workspaceId: f.workspaceId, jobId, keyId: f.key.id,
                billing: 'managed', reservedMicros: 80,
              });
            });
            now = new Date('2026-02-01T00:00:01Z');
            const replay = await reserve();
            const settled = await f.tx(c => store.settleInTransaction(c, f.workspaceId, jobId, 70));
            const duplicate = await f.tx(c => store.settleInTransaction(c, f.workspaceId, jobId, 70));
            const bucket = (await f.pool.query(
              "SELECT to_char(admission_month,'YYYY-MM-DD') AS month,gross_debit_micros,held_micros FROM mr_key_months"
            )).rows;
            console.log(JSON.stringify({
              months: [admitted, replay, settled, duplicate].map(r => r.admissionMonth),
              admittedAt: admitted.admittedAt, bucket,
            }));
          } finally { await f.close(); }
          `,
        ],
        {
          cwd: root,
          env: {
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            TMPDIR: tmpdir(),
            TZ: timezone,
            TEST_DATABASE_URL: databaseUrl!,
            TEST_NATIVE_POSTGRES: process.env.TEST_NATIVE_POSTGRES === '1' ? '1' : '0',
          },
          timeout: 12_000,
          maxBuffer: 8_192,
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        months: Array(4).fill('2026-01-01'),
        admittedAt: '2026-01-31T23:59:59.000Z',
        bucket: [{ month: '2026-01-01', gross_debit_micros: '70', held_micros: '0' }],
      });
    },
  );
});
