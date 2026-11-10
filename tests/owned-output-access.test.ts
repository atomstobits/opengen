import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { OwnedOutputAccess } from '../packages/engine/src/owned-output-access';

const id = '0171cd13-c992-4ac0-87d2-4f59092bca9d';
const object = '0171cd13-c992-4ac0-87d2-4f59092bca9e';
const key = `outputs/${id}/${object}.png`;
const output = {
  storageKey: key,
  mediaType: 'image/png',
  byteLength: 100,
  url: 'https://provider.invalid/private-output?token=synthetic',
  inline: 'synthetic-private-bytes',
  receipt: { secret: 'synthetic-private-receipt' },
  fidelity: 'unverified',
};
const row = { id, status: 'succeeded', delivery_status: 'available', outputs: [output] };
function mocked(value: unknown) {
  const query = vi.fn().mockResolvedValue({ rows: value === null ? [] : [value] });
  return { access: new OwnedOutputAccess({ query } as unknown as Pick<Pool, 'query'>), query };
}

describe('private owned-output metadata', () => {
  it('allowlists descriptors and never returns or follows a provider URL', async () => {
    const { access, query } = mocked(row);
    const result = await access.getOwnedOutputJob('workspace-one', id);
    expect(result).toEqual({
      id,
      status: 'succeeded',
      deliveryStatus: 'available',
      outputs: [{ storageKey: key, mediaType: 'image/png', byteLength: 100 }],
    });
    expect(JSON.stringify(result)).not.toMatch(/provider|receipt|inline|fidelity|synthetic/);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /SELECT id,status,delivery_status,outputs FROM mr_jobs\s+WHERE workspace_id=\$1 AND id=\$2 LIMIT 1/,
      ),
      ['workspace-one', id],
    );
  });

  it('accepts a deterministic owned JPEG descriptor without an optional byte count', async () => {
    const value = {
      ...row,
      outputs: [{ storageKey: key.replace('.png', '.jpg'), mediaType: 'image/jpeg' }],
    };
    expect((await mocked(value).access.getOwnedOutputJob('workspace-one', id))?.outputs).toEqual(
      value.outputs,
    );
  });

  it.each(['queued', 'submitting', 'running', 'submission-unknown', 'failed', 'cancelled'])(
    'never provides bytes for generation status %s',
    async (status) => {
      expect(
        (await mocked({ ...row, status }).access.getOwnedOutputJob('one', id))?.outputs,
      ).toEqual([]);
    },
  );

  it.each(['pending', 'partial', 'failed', 'expired', 'unverified', null, 'future-unknown'])(
    'never provides bytes for delivery status %s',
    async (delivery_status) => {
      expect(
        (await mocked({ ...row, delivery_status }).access.getOwnedOutputJob('one', id))?.outputs,
      ).toEqual([]);
    },
  );

  it.each([
    { ...output, storageKey: undefined },
    { ...output, storageKey: key.replace(id, object) },
    { ...output, storageKey: `inputs/one/${object}.png` },
    { ...output, storageKey: `outputs/${id}/../${object}.png` },
    { ...output, storageKey: `outputs/${id}/%2e%2e/${object}.png` },
    { ...output, storageKey: `${key}?token=synthetic` },
    { ...output, mediaType: 'video/mp4' },
    { ...output, mediaType: 'text/html' },
    { ...output, byteLength: -1 },
    { ...output, byteLength: 100 * 1024 * 1024 + 1 },
    { ...output, byteLength: '100' },
    null,
  ])('fails closed for malformed metadata without shifting indexes %j', async (invalid) => {
    expect(
      (await mocked({ ...row, outputs: [output, invalid] }).access.getOwnedOutputJob('one', id))
        ?.outputs,
    ).toEqual([]);
  });

  it.each([null, {}, [], Array.from({ length: 16 }, () => output)].map((outputs) => ({ outputs })))(
    'bounds and validates persisted output collections %j',
    async ({ outputs }) => {
      expect(
        (await mocked({ ...row, outputs }).access.getOwnedOutputJob('one', id))?.outputs,
      ).toEqual([]);
    },
  );

  it('returns null for missing/malformed identities before issuing unbounded queries', async () => {
    const { access, query } = mocked(null);
    expect(await access.getOwnedOutputJob('one', 'not-a-uuid')).toBeNull();
    expect(await access.getOwnedOutputJob('', id)).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(await access.getOwnedOutputJob('one', id)).toBeNull();
  });
});

describe('workspace-scoped owned-output SQL', () => {
  const database = new PGlite();
  const access = new OwnedOutputAccess(database as unknown as Pick<Pool, 'query'>);
  beforeAll(async () => {
    await database.exec(`CREATE TABLE mr_jobs (
      id uuid PRIMARY KEY, workspace_id text NOT NULL,
      status text NOT NULL, delivery_status text, outputs jsonb NOT NULL
    )`);
    await database.query(
      `INSERT INTO mr_jobs(id,workspace_id,status,delivery_status,outputs)
       VALUES($1,'workspace-one','succeeded','available',$2)`,
      [id, JSON.stringify([output])],
    );
  });
  afterAll(async () => {
    await database.close();
  });

  it('authorizes the row in SQL and returns only an owned descriptor', async () => {
    expect((await access.getOwnedOutputJob('workspace-one', id))?.outputs[0]?.storageKey).toBe(key);
    expect(await access.getOwnedOutputJob('workspace-two', id)).toBeNull();
    expect(await access.getOwnedOutputJob("workspace-one' OR 1=1 --", id)).toBeNull();
    expect(await access.getOwnedOutputJob('workspace-one', object)).toBeNull();
  });
});
