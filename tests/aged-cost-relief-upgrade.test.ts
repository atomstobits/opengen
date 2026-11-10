import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import { createEngine, TermsReceiptStore } from '@media-router/engine';
import { agedCostReliefTestDatabaseUrl } from './aged-cost-relief-fixture.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ? agedCostReliefTestDatabaseUrl(process.env.TEST_DATABASE_URL)
  : undefined;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const migration = (name: string) =>
  readFile(new URL(`../packages/engine/migrations/${name}`, import.meta.url), 'utf8');
const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Unexpected fixture identifier.');
  return `"${name}"`;
};

it('preserves the reviewed 001–029 source migration checksums', async () => {
  for (const [name, checksum] of Object.entries(historicalChecksums))
    expect(sha256(await migration(name)), name).toBe(checksum);
});

it.skipIf(!databaseUrl)(
  'upgrades populated 030 to 031 without rewriting original columns, money, authority, accepted work or migration receipts',
  async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'aged_relief_upgrade');
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
      for (let index = 1; index <= 30; index++) {
        const name = `${String(index).padStart(3, '0')}.sql`;
        const sql = await migration(name);
        if (name in historicalChecksums)
          expect(sha256(sql), name).toBe(
            historicalChecksums[name as keyof typeof historicalChecksums],
          );
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
          name,
          sha256(sql),
        ]);
      }

      const issuer = 'https://identity.fixture.invalid/aged-relief-upgrade';
      const owner = await engine.accounts.identity(issuer, 'original-owner');
      const invitee = await engine.accounts.identity(issuer, 'original-invitee');
      const team = await engine.accounts.createTeam(owner, 'Original funded team');
      const session = await engine.accounts.createSession(owner);
      const administrator = await engine.accounts.switchSession(session, owner, team.id);
      const invitation = await engine.accounts.inviteMember(administrator, {
        issuer,
        subject: invitee.identity!.subject,
        role: 'member',
      });
      const policy = await engine.accounts.savePolicy(team.id, {
        name: 'Original regional policy',
        policy: { endpointRegions: ['ap-southeast-1'], fallback: false },
        maxCostMicros: 1_000_000,
      });
      const key = await engine.accounts.createKey(
        team.id,
        { name: 'Original accepted-work key', scopes: ['read', 'generate'], policyId: policy.id },
        administrator.membershipId,
      );
      await db.query('UPDATE mr_api_keys SET monthly_cap_micros=3000000 WHERE id=$1', [key.id]);
      await engine.creditWorkspace(team.id, 5_000_000, 'original-operator-funding');
      await new TermsReceiptStore(db).recordVerifiedAcceptance({
        issuer,
        subject: owner.identity!.subject,
        policyVersion: 'synthetic-original-terms-v1',
        policyDigest: 'a'.repeat(64),
      });

      const client = await engine.mcpOAuth.registerClient(
        {
          clientName: 'Original read client',
          redirectUris: ['https://client.fixture.invalid/callback'],
        },
        'fixture',
      );
      const authorization = await engine.mcpOAuth.beginAuthorization(
        {
          clientId: client.client_id,
          redirectUri: client.redirect_uris[0]!,
          responseType: 'code',
          codeChallenge: 'a'.repeat(43),
          codeChallengeMethod: 'S256',
          resource: engine.mcpOAuth.resource,
        },
        'fixture',
      );
      await engine.mcpOAuth.approve(authorization.requestId, administrator, team.id, ['read']);

      const route = catalog.routes.find((value) => value.id === 'alibaba/ap-southeast-1/wan-3.0')!;
      const deployment = catalog.deployments.find((value) => value.id === route.deploymentId)!;
      const originalInput = {
        modelId: route.modelId,
        routeId: route.id,
        operation: 'text-to-video',
        input: { prompt: 'Synthetic pre031 accepted work.', resolution: '720p', duration: 2 },
        maxCostMicros: 1_000_000,
      };
      const pools = { workspace: `workspace:${team.id}`, provider: 'provider:original-fixture' };
      for (const [kind, id] of Object.entries(pools))
        await db.query(
          'INSERT INTO mr_execution_pools(id,kind,max_active,max_queued) VALUES($1,$2,4,100)',
          [id, kind],
        );
      const month = (
        await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-01') AS value")
      ).rows[0].value as string;
      await db.query(
        `INSERT INTO mr_key_months(workspace_id,key_id,admission_month,gross_debit_micros,held_micros)
         VALUES($1,$2,$3,0,2000000)`,
        [team.id, key.id, month],
      );
      const acceptedJobs: { id: string; upstreamId: string | null; status: string }[] = [];
      for (const [status, upstreamId, slotState] of [
        ['running', 'original-provider-task', 'occupied'],
        ['submission-unknown', null, 'unknown'],
      ] as const) {
        const id = randomUUID();
        acceptedJobs.push({ id, upstreamId, status });
        await db.query(
          `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,
             deployment_snapshot,status,upstream_id,reserved_micros,attempt_count,attribution,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1000000,1,$10,$11)`,
          [
            id,
            team.id,
            randomUUID(),
            sha256(JSON.stringify(originalInput)),
            JSON.stringify(originalInput),
            JSON.stringify(route),
            JSON.stringify(deployment),
            status,
            upstreamId,
            JSON.stringify({
              kind: 'api',
              keyId: key.id,
              membershipId: administrator.membershipId,
              grantId: null,
              clientId: null,
            }),
            JSON.stringify({ project: 'Original private project' }),
          ],
        );
        await db.query(
          `INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state)
           VALUES($1,$2,1,$3,$4,$5)`,
          [
            randomUUID(),
            id,
            route.id,
            deployment.id,
            status === 'running' ? 'running' : 'submitting',
          ],
        );
        const credentialIdentity = `injected:${'b'.repeat(64)}`;
        await db.query(
          `INSERT INTO mr_job_credentials(job_id,workspace_id,deployment_id,kind,identity)
           VALUES($1,$2,$3,'injected',$4)`,
          [id, team.id, deployment.id, credentialIdentity],
        );
        await db.query(
          `INSERT INTO mr_attempt_credentials(job_id,attempt_number,workspace_id,deployment_id,identity)
           VALUES($1,1,$2,$3,$4)`,
          [id, team.id, deployment.id, credentialIdentity],
        );
        await db.query(
          `INSERT INTO mr_dispatch_slots(job_id,attempt_number,workspace_id,workspace_pool_id,
             provider_pool_id,state,submission_intent_at) VALUES($1,1,$2,$3,$4,$5,clock_timestamp())`,
          [id, team.id, pools.workspace, pools.provider, slotState],
        );
        await db.query(
          `INSERT INTO mr_key_reservations(job_id,workspace_id,key_id,admission_month,reserved_micros,admitted_at)
           VALUES($1,$2,$3,$4,1000000,clock_timestamp())`,
          [id, team.id, key.id, month],
        );
        await db.query(
          'UPDATE mr_workspaces SET available_micros=available_micros-1000000,reserved_micros=reserved_micros+1000000 WHERE id=$1',
          [team.id],
        );
        await db.query(
          `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
           VALUES($1,$2,$3,'reserve',1000000,-1000000,1000000)`,
          [randomUUID(), team.id, id],
        );
      }
      const orderId = randomUUID();
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,
           status,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id)
         VALUES($1,$2,'original-checkout',500,5000000,false,'checkout_pending',
           'original-checkout-key','fixture-aged-relief-upgrade','cs_test_original','pi_original')`,
        [orderId, team.id],
      );
      await db.query(
        `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,state)
         VALUES('evt_original_aged_relief','charge.refunded','ch_original','pi_original',false,$1,'processed')`,
        [orderId],
      );
      await db.query(
        `INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason)
         VALUES('evt_original_aged_relief',$1,$2,'charge.refunded')`,
        [team.id, orderId],
      );

      const oldColumns = (
        await db.query<{ table_name: string; column_name: string }>(
          `SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,
             is_identity,identity_generation,character_maximum_length,numeric_precision,numeric_scale,datetime_precision
           FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE 'mr_%'
           ORDER BY table_name,ordinal_position`,
          [isolated.schema],
        )
      ).rows;
      const columns = new Map<string, string[]>();
      for (const column of oldColumns)
        columns.set(column.table_name, [
          ...(columns.get(column.table_name) ?? []),
          column.column_name,
        ]);
      const snapshot = async () => {
        const rows: Record<string, { value: string }[]> = {};
        for (const [table, names] of columns)
          if (table !== 'mr_migrations')
            rows[table] = (
              await db.query<{ value: string }>(
                `SELECT row_to_json(t)::text AS value FROM
                 (SELECT ${names.map(identifier).join(',')} FROM ${identifier(table)}) t
                 ORDER BY row_to_json(t)::text COLLATE "C"`,
              )
            ).rows;
        return rows;
      };
      const before = await snapshot();
      const originalLedgerIds = (
        await db.query<{ id: string }>('SELECT id FROM mr_ledger ORDER BY id')
      ).rows.map((row) => row.id);
      const journal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      expect(journal.map((row) => row.name)).toEqual(
        Array.from({ length: 30 }, (_, index) => `${String(index + 1).padStart(3, '0')}.sql`),
      );
      for (const name of ['mr_aged_cost_reliefs', 'mr_aged_cost_relief_settlements'])
        expect(
          (await db.query('SELECT to_regclass($1) AS value', [name])).rows[0].value,
        ).toBeNull();

      await engine.initialize();
      const upgradedJournal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      expect(upgradedJournal.slice(0, 30)).toEqual(journal);
      expect(upgradedJournal).toHaveLength(31);
      expect(upgradedJournal[30]).toMatchObject({
        name: '031.sql',
        checksum: sha256(await migration('031.sql')),
      });
      const assertPreserved = async () => {
        expect(await snapshot()).toEqual(before);
        expect(
          (
            await db.query(
              `SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,
                 is_identity,identity_generation,character_maximum_length,numeric_precision,numeric_scale,datetime_precision
               FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])
               ORDER BY table_name,ordinal_position`,
              [isolated.schema, [...columns.keys()]],
            )
          ).rows.filter((column) => columns.get(column.table_name)?.includes(column.column_name)),
        ).toEqual(oldColumns);
        expect(
          (
            await db.query(
              'SELECT id,posting_order::text FROM mr_ledger WHERE id=ANY($1::uuid[]) ORDER BY id',
              [originalLedgerIds],
            )
          ).rows,
        ).toEqual(originalLedgerIds.map((id) => ({ id, posting_order: null })));
        expect((await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows).toEqual(
          upgradedJournal,
        );
        for (const table of ['mr_aged_cost_reliefs', 'mr_aged_cost_relief_settlements'])
          expect(
            (await db.query(`SELECT count(*)::integer AS count FROM ${identifier(table)}`)).rows[0]
              .count,
          ).toBe(0);
      };
      await assertPreserved();
      for (let restart = 0; restart < 2; restart++) {
        await engine.initialize();
        await assertPreserved();
      }
      expect(await engine.accounts.authenticate(key.token)).toMatchObject({
        workspaceId: team.id,
        scopes: ['read', 'generate'],
        keySecretVersion: 1,
      });
      expect(await engine.accounts.session(session)).toMatchObject({
        workspaceId: team.id,
        membershipId: administrator.membershipId,
      });
      expect(
        (await db.query('SELECT accepted_at FROM mr_memberships WHERE id=$1', [invitation.id]))
          .rows[0].accepted_at,
      ).toBeNull();
      expect(await engine.getBalance(team.id)).toEqual({
        availableMicros: 3_000_000,
        reservedMicros: 2_000_000,
        currency: 'USD',
      });
      expect(
        (
          await db.query(
            'SELECT gross_debit_micros::text,held_micros::text FROM mr_key_months WHERE key_id=$1',
            [key.id],
          )
        ).rows,
      ).toEqual([{ gross_debit_micros: '0', held_micros: '2000000' }]);
      for (const original of acceptedJobs)
        expect(
          (
            await db.query(
              'SELECT status,upstream_id,settled_micros,upstream_cost_micros FROM mr_jobs WHERE id=$1',
              [original.id],
            )
          ).rows[0],
        ).toEqual({
          status: original.status,
          upstream_id: original.upstreamId,
          settled_micros: null,
          upstream_cost_micros: null,
        });
    } finally {
      await engine.close();
      await isolated.close();
    }
  },
  60_000,
);

// Pinned from reviewed main126f02eb387ac86261dc150a3daee5ecf9ae4fe7.
// Migration030 is owned by its source PR and is checksummed when installing the predecessor.
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
  '029.sql': '17633c526c0122b552891c83163c7c321542b05848f1c333d6aca460d250645d',
};
