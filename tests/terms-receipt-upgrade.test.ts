import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/(?:postgres|opengen_test|opengen_identity_terms_[a-z0-9_]+|opengen_core_qualification_[a-z0-9_]+)$/.test(
      target.pathname,
    ) ||
    target.search ||
    target.hash
  )
    throw new Error('Terms upgrade tests require an explicit loopback fixture database.');
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const migration = (name: string) =>
  readFile(new URL(`../packages/engine/migrations/${name}`, import.meta.url), 'utf8');
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected fixture identifier.');
  return `"${value}"`;
};

it('preserves the exact reviewed 001–028 migration bytes', async () => {
  for (const [name, checksum] of Object.entries(historicalChecksums))
    expect(sha256(await migration(name)), name).toBe(checksum);
});

it.skipIf(!databaseUrl)(
  'appends 029 to populated 028 without changing any prior row, authority, money, jobs, holds or journal entry',
  async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'terms_upgrade');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        adapters: [],
        providerEnv: {},
        providerExecutionEnabled: false,
      }),
    );
    try {
      const db = engine.pool;
      await db.query(
        'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const [name, checksum] of Object.entries(historicalChecksums)) {
        const sql = await migration(name);
        expect(sha256(sql)).toBe(checksum);
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      }
      const issuer = 'https://identity.fixture.invalid/terms-upgrade';
      const owner = await engine.accounts.identity(issuer, 'original-owner');
      const recipient = await engine.accounts.identity(issuer, 'original-invitee');
      const team = await engine.accounts.createTeam(owner, 'Original team');
      const browserSession = await engine.accounts.createSession(owner);
      const administrator = await engine.accounts.switchSession(browserSession, owner, team.id);
      const invitation = await engine.accounts.inviteMember(administrator, {
        issuer,
        subject: recipient.identity!.subject,
        role: 'member',
      });
      const key = await engine.accounts.createKey(
        team.id,
        {
          name: 'Original scoped agent',
          scopes: ['read', 'generate'],
        },
        administrator.membershipId,
      );
      await engine.creditWorkspace(team.id, 5_000_000, 'original-operator-funding');
      for (const [status, upstream] of [
        ['running', 'original-provider-task'],
        ['submission-unknown', null],
      ] as const) {
        const job = randomUUID();
        await db.query(
          `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,
            deployment_snapshot,status,upstream_id,reserved_micros,attempt_count)
            VALUES($1,$2,$3,'fixture-hash','{}','{}','{}',$4,$5,1000000,1)`,
          [job, team.id, randomUUID(), status, upstream],
        );
        await db.query(
          "INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,'original-route','original-deployment',$3)",
          [randomUUID(), job, status],
        );
        await db.query(
          'UPDATE mr_workspaces SET available_micros=available_micros-1000000,reserved_micros=reserved_micros+1000000 WHERE id=$1',
          [team.id],
        );
        await db.query(
          "INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,$3,'reserve',1000000,-1000000,1000000)",
          [randomUUID(), team.id, job],
        );
      }
      const order = randomUUID();
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,
          status,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id)
          VALUES($1,$2,'original-checkout',500,5000000,false,'checkout_pending',
          'original-checkout-key','fixture-terms-upgrade','cs_test_original','pi_original')`,
        [order, team.id],
      );
      await db.query(
        "INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,state) VALUES('evt_original_terms_upgrade','charge.refunded','ch_original','pi_original',false,$1,'processed')",
        [order],
      );
      await db.query(
        "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES('evt_original_terms_upgrade',$1,$2,'charge.refunded')",
        [team.id, order],
      );

      const priorTables = (
        await db.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'mr_%' ORDER BY tablename",
          [isolated.schema],
        )
      ).rows.map((row) => row.tablename);
      const snapshot = async () => {
        const rows: Record<string, { value: string }[]> = {};
        for (const table of priorTables) {
          const value =
            table === 'mr_ledger' ? "(to_jsonb(t)-'posting_order')::text" : 'row_to_json(t)::text';
          rows[table] = (
            await db.query<{ value: string }>(
              `SELECT ${value} AS value FROM ${identifier(table)} t
             ORDER BY ${value} COLLATE "C"`,
            )
          ).rows;
        }
        return rows;
      };
      const before = await snapshot();
      const oldJournal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      expect(oldJournal).toHaveLength(28);
      expect(
        (await db.query("SELECT to_regclass('mr_terms_receipts') AS name")).rows[0].name,
      ).toBeNull();
      await engine.initialize();
      const journal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      expect(journal.slice(0, 28)).toEqual(oldJournal);
      expect(journal).toHaveLength(31);
      expect(journal[28]).toMatchObject({
        name: '029.sql',
        checksum: sha256(await migration('029.sql')),
      });
      const after = await snapshot();
      // Journal is itself in the all-table snapshot; compare every original row while
      // separately verifying the one legitimate new journal entry above.
      after.mr_migrations = after.mr_migrations!.filter(
        (row) => !['029.sql', '030.sql', '031.sql'].includes(JSON.parse(row.value).name),
      );
      expect(after).toEqual(before);
      expect(
        (await db.query('SELECT count(*)::integer AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(0);
      const receipts = new TermsReceiptStore(db);
      await receipts.recordVerifiedAcceptance({
        issuer,
        subject: owner.identity!.subject,
        policyVersion: 'terms-upgrade-fixture-v1',
        policyDigest: 'a'.repeat(64),
      });
      await engine.initialize();
      expect((await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows).toEqual(journal);
      const afterRestart = await snapshot();
      afterRestart.mr_migrations = afterRestart.mr_migrations!.filter(
        (row) => !['029.sql', '030.sql', '031.sql'].includes(JSON.parse(row.value).name),
      );
      expect(afterRestart).toEqual(before);
      expect(
        (await db.query('SELECT accepted_at FROM mr_memberships WHERE id=$1', [invitation.id]))
          .rows[0].accepted_at,
      ).toBeNull();
      expect(await engine.accounts.authenticate(key.token)).toMatchObject({
        workspaceId: team.id,
        scopes: ['read', 'generate'],
      });
      expect(await engine.accounts.session(browserSession)).toMatchObject({ workspaceId: team.id });
      expect(await engine.getBalance(team.id)).toEqual({
        availableMicros: 3_000_000,
        reservedMicros: 2_000_000,
        currency: 'USD',
      });
      for (const [name, checksum] of Object.entries(historicalChecksums))
        expect(sha256(await migration(name)), name).toBe(checksum);
    } finally {
      await engine.close();
      await isolated.close();
    }
  },
  60_000,
);

// Pinned from the assigned main 2d439f8 baseline, not regenerated by the test.
const historicalChecksums = {
  '001.sql': 'b9dfad12d57ac008293cbf50545448e79eefd5b1b33fbb221532b9b1f85337e8',
  '002.sql': 'ef23085a0103e1323668eebab056b15c6455ca4e4f67bd5468d29bd8e4e6f055',
  '003.sql': 'e3fadb90a30a16f878d249d22242ca7f952a300fc21e3e1379f2f5018857fe2c',
  '004.sql': '71336b7c6e81471fb43f986ac5b7d4533d16ff6bb359625e0a13faa50bf173aa',
  '005.sql': 'f0e0770d17f3d44608a49c26fdeb45df8583388ae63d0e8886ce259af4074cfa',
  '006.sql': 'e37803a0ffa9e7481cd81fa085dbf905f7a584fdf4deac8800274cc99837bff2',
  '007.sql': 'bbcc4ee28746b2c67fac6fee668af502df5b7e9964338cb11b67a56fffca420a',
  '008.sql': 'a515f9615c2eb8014684c225124899609d3ddc05607e65ed5cded58a4b0dc2b7',
  '009.sql': '59d2b67c8844a5e4444621dd1469e8d7de155b91bdaebfdf7de460d3076f2fc7',
  '010.sql': 'ce3f0642439fec766989636f254693f25152e4fca570acecfdba44ca2ff810a6',
  '011.sql': '896ae05b21cc536c05167335592a885b30cab9603ef644a17a4180f6b95861b0',
  '012.sql': '4c07054174c755528443e0778752155f55344564c1a5e4154009bb1a0d424d57',
  '013.sql': 'b1e85fada297f91f580b07e62951a346d89025e637a04b57eebe433d00d41a90',
  '014.sql': '215077f11ae3ffbd5bfc2e9214107f4dd913266af797351b5e4e0894ec5ecad2',
  '015.sql': '623ffa1afecc27cd4c16aeda9dbb334a8f3060532185c62e558d7beb40db5560',
  '016.sql': '1ccc94ec6a9c430f684ea160d7fbeb88c2247ae63b9a89e0f285a72cc341e3a0',
  '017.sql': '5604fb14b10fc84a078d91f34733f56303424739229a0da8a26f1ebac2685868',
  '018.sql': 'a1a0801e8a80c1a03dddbde7528486e7abdf2a3546b886064bca4dc28186be58',
  '019.sql': '95db534a334537fb728c89bafd16d8dc0fc446c97e8794dfc7d4f9d48a897ce7',
  '020.sql': 'bf392230e0b44531d8c10c109c385f2c6e9d902088922a399cad4fe9a2e349ab',
  '021.sql': '25ab22dc6364e4fc84563c79671d1f12b0a391de9a4353f95d25d80bac44f292',
  '022.sql': '4f3db2c678439ac6670a19b06b66a0b4b91cd68106ef005df2b42a2ae568cfea',
  '023.sql': '92d37cdea7a4192448fadf30feaad4554eaad0a5e137779b3f937ffc240485d5',
  '024.sql': 'a4b8eec363d7a8d4ceb55648aae4b03ea0ea7969241a3aefac2cb7276687a19b',
  '025.sql': '6d396b28118128ad8ee10db4096b642c026089b6a790bdb1613033fe5b87f009',
  '026.sql': 'f7e673911e8857a92c6f20ef5398bb68647ec13ec6b84d229eed24d91886cbd8',
  '027.sql': '494bb119b40bf94b6b77143aeaca600bbe17416c0c981d252c097461df14aca8',
  '028.sql': '028fd43ab00b5ef24ceeb575dafa16a725736b3e492f0ab42fa3ff0c920ab43d',
};
