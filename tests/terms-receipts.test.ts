import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createEngine } from '@media-router/engine';
import {
  TermsReceiptStore,
  type TermsReceipt,
  type VerifiedTermsAcceptance,
} from '../packages/engine/src/terms-receipts.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const acceptance = {
  issuer: 'https://identity.fixture.invalid/tenant',
  subject: 'verified-case-sensitive-subject',
  policyVersion: 'terms-fixture-v1',
  policyDigest: 'a'.repeat(64),
};
const receipt: TermsReceipt = {
  ...acceptance,
  noticeVersion: 'human-terms-continue-v1',
  action: 'continue',
  method: 'oidc-verified',
  acceptedAt: new Date('2026-11-09T00:00:00Z'),
};

describe('internal Terms receipt input boundary', () => {
  it.each([
    null,
    undefined,
    [],
    {},
    { ...acceptance, acceptedAt: '2026-11-09T00:00:00Z' },
    { ...acceptance, timestamp: 1 },
    { ...acceptance, action: 'continue' },
    { ...acceptance, method: 'oidc-verified' },
    { ...acceptance, noticeVersion: 'human-terms-continue-v1' },
    { ...acceptance, workspaceId: 'unrelated-workspace' },
    { ...acceptance, ip: '127.0.0.1' },
    { ...acceptance, issuer: '' },
    { ...acceptance, issuer: 'not-an-issuer-url' },
    { ...acceptance, issuer: 'https://user:private@identity.fixture.invalid' },
    { ...acceptance, issuer: 'https://identity.fixture.invalid/?value=1' },
    { ...acceptance, issuer: 'https://identity.fixture.invalid/#value' },
    { ...acceptance, issuer: 'http://remote.fixture.invalid' },
    { ...acceptance, issuer: ' https://identity.fixture.invalid' },
    { ...acceptance, issuer: `https://identity.fixture.invalid/${'a'.repeat(1024)}` },
    { ...acceptance, subject: '' },
    { ...acceptance, subject: '   ' },
    { ...acceptance, subject: 'subject\nforged-log' },
    { ...acceptance, subject: '🔒'.repeat(129) },
    { ...acceptance, subject: 1 },
    { ...acceptance, policyVersion: ' terms-fixture-v1' },
    { ...acceptance, policyVersion: 'not/a-version' },
    { ...acceptance, policyVersion: 'a'.repeat(121) },
    { ...acceptance, policyDigest: 'A'.repeat(64) },
    { ...acceptance, policyDigest: 'a'.repeat(63) },
    { ...acceptance, policyDigest: 'g'.repeat(64) },
  ])('rejects malformed or extra input before touching the database (%#)', async (raw) => {
    const query = vi.fn();
    const store = new TermsReceiptStore({ query } as unknown as Pool);
    await expect(
      store.recordVerifiedAcceptance(raw as VerifiedTermsAcceptance),
    ).rejects.toMatchObject({ code: 'terms_receipt_input_invalid' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects accessors, inherited payloads and hidden/symbol fields', async () => {
    const query = vi.fn();
    const accessor = vi.fn(() => acceptance.subject);
    const store = new TermsReceiptStore({ query } as unknown as Pool);
    for (const raw of [
      Object.create(acceptance),
      { ...acceptance, [Symbol('extra')]: 'hidden' },
      Object.defineProperty({ ...acceptance }, 'acceptedAt', { value: new Date() }),
      Object.defineProperty({ ...acceptance }, 'subject', { get: accessor }),
    ])
      await expect(store.recordVerifiedAcceptance(raw)).rejects.toMatchObject({
        code: 'terms_receipt_input_invalid',
      });
    expect(accessor).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('passes only the exact identity/version/digest to INSERT and returns DB-chosen metadata', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [receipt] });
    const store = new TermsReceiptStore({ query } as unknown as Pool);
    expect(await store.recordVerifiedAcceptance(acceptance)).toEqual(receipt);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual(Object.values(acceptance));
    expect(query.mock.calls[0]?.[0]).toContain(
      'INSERT INTO mr_terms_receipts(issuer,subject,policy_version,policy_digest)',
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('DO UPDATE');
  });

  it('returns the original immutable row on a retry and fails if it cannot confirm one', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [receipt] });
    expect(
      await new TermsReceiptStore({ query } as unknown as Pool).recordVerifiedAcceptance(
        acceptance,
      ),
    ).toEqual(receipt);
    expect(query.mock.calls[1]?.[1]).toEqual([
      acceptance.issuer,
      acceptance.subject,
      acceptance.policyVersion,
    ]);
    const absent = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      new TermsReceiptStore({ query: absent } as unknown as Pool).recordVerifiedAcceptance(
        acceptance,
      ),
    ).rejects.toMatchObject({ code: 'terms_receipt_unavailable' });
  });

  it('does not normalize issuer/subject identity or reinterpret another digest', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...receipt, issuer: `${acceptance.issuer}/`, subject: ' subject ' }],
    });
    await new TermsReceiptStore({ query } as unknown as Pool).recordVerifiedAcceptance({
      ...acceptance,
      issuer: `${acceptance.issuer}/`,
      subject: ' subject ',
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      `${acceptance.issuer}/`,
      ' subject ',
      acceptance.policyVersion,
      acceptance.policyDigest,
    ]);
    const conflict = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [receipt] });
    await expect(
      new TermsReceiptStore({ query: conflict } as unknown as Pool).recordVerifiedAcceptance({
        ...acceptance,
        policyDigest: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'terms_receipt_policy_conflict', statusCode: 409 });
  });
});

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
    throw new Error('Terms receipt tests require an explicit loopback fixture database.');
}
async function withStore(run: (store: TermsReceiptStore, pool: Pool) => Promise<void>) {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'terms_receipt');
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      poolSize: 4,
      adapters: [],
      providerEnv: {},
      providerExecutionEnabled: false,
    }),
  );
  try {
    await engine.initialize();
    await run(new TermsReceiptStore(engine.pool), engine.pool);
  } finally {
    await engine.close();
    await isolated.close();
  }
}

describe.skipIf(!databaseUrl)('immutable database Terms receipts', () => {
  it('records before account creation, keeps the original timestamp on retry, and scopes identity/version exactly', async () =>
    withStore(async (store, db) => {
      const before = (await db.query('SELECT clock_timestamp() AS value')).rows[0].value;
      const first = await store.recordVerifiedAcceptance(acceptance);
      const after = (await db.query('SELECT clock_timestamp() AS value')).rows[0].value;
      expect(first).toMatchObject({
        ...acceptance,
        noticeVersion: 'human-terms-continue-v1',
        action: 'continue',
        method: 'oidc-verified',
      });
      expect(first.acceptedAt).toBeInstanceOf(Date);
      expect(first.acceptedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(first.acceptedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(await store.recordVerifiedAcceptance(acceptance)).toEqual(first);
      for (const input of [
        { ...acceptance, subject: 'Verified-case-sensitive-subject' },
        { ...acceptance, issuer: `${acceptance.issuer}/` },
        { ...acceptance, policyVersion: 'terms-fixture-v2', policyDigest: 'b'.repeat(64) },
      ])
        expect(await store.recordVerifiedAcceptance(input)).toMatchObject(input);
      expect(
        (await db.query('SELECT count(*)::integer AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(4);
      expect((await db.query('SELECT count(*)::integer AS n FROM mr_identities')).rows[0].n).toBe(
        0,
      );
      expect((await db.query('SELECT count(*)::integer AS n FROM mr_workspaces')).rows[0].n).toBe(
        0,
      );
      expect(
        (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='mr_terms_receipts' ORDER BY ordinal_position",
          )
        ).rows.map((row) => row.column_name),
      ).toEqual([
        'issuer',
        'subject',
        'policy_version',
        'policy_digest',
        'notice_version',
        'action',
        'method',
        'accepted_at',
      ]);
    }));

  it('serializes concurrent matching retries and makes one digest win a conflicting race without overwriting it', async () =>
    withStore(async (store, db) => {
      const retries = await Promise.all(
        Array.from({ length: 6 }, () => store.recordVerifiedAcceptance(acceptance)),
      );
      expect(
        retries.every((row) => row.acceptedAt.getTime() === retries[0]!.acceptedAt.getTime()),
      ).toBe(true);
      const identity = { ...acceptance, subject: 'digest-race' };
      const results = await Promise.allSettled(
        ['c', 'd'].map((value) =>
          store.recordVerifiedAcceptance({ ...identity, policyDigest: value.repeat(64) }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'terms_receipt_policy_conflict' },
      });
      const winner = results.find((result) => result.status === 'fulfilled');
      expect(winner?.status).toBe('fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('No receipt race winner.');
      expect(
        await store.recordVerifiedAcceptance({
          ...identity,
          policyDigest: winner.value.policyDigest,
        }),
      ).toEqual(winner.value);
      expect(
        (await db.query('SELECT count(*)::integer AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(2);
    }));

  it('rejects SQL update/delete/truncate and direct fixed-action or digest constraint violations', async () =>
    withStore(async (store, db) => {
      const first = await store.recordVerifiedAcceptance(acceptance);
      for (const sql of [
        "UPDATE mr_terms_receipts SET policy_digest=repeat('b',64)",
        'UPDATE mr_terms_receipts SET accepted_at=clock_timestamp()',
        'DELETE FROM mr_terms_receipts',
        'TRUNCATE mr_terms_receipts',
        'TRUNCATE mr_terms_receipts CASCADE',
      ])
        await expect(db.query(sql)).rejects.toMatchObject({ code: '55000' });
      for (const override of [
        { column: 'notice_version', value: 'other-notice' },
        { column: 'action', value: 'account-created' },
        { column: 'method', value: 'membership-created' },
        { column: 'policy_digest', value: 'invalid-digest' },
      ]) {
        const digest =
          override.column === 'policy_digest' ? override.value : acceptance.policyDigest;
        const extra = override.column === 'policy_digest' ? '' : `,${override.column}`;
        const value = override.column === 'policy_digest' ? '' : ',$5';
        await expect(
          db.query(
            `INSERT INTO mr_terms_receipts(issuer,subject,policy_version,policy_digest${extra}) VALUES($1,$2,$3,$4${value})`,
            [
              acceptance.issuer,
              'invalid-direct-insert',
              acceptance.policyVersion,
              digest,
              ...(extra ? [override.value] : []),
            ],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect(await store.recordVerifiedAcceptance(acceptance)).toEqual(first);
      expect(
        (await db.query('SELECT count(*)::integer AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(1);
    }));
});
