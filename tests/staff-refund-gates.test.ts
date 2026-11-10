import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import {
  StaffRefundStore,
  type StaffRefundStoreOptions,
} from '../packages/engine/src/staff-refunds.js';
import type { VerifiedStaffRefundEvidence } from '../packages/engine/src/staff-refund-evidence.js';

const environment = {
  id: 'fixture-staff-refunds',
  accountId: 'acct_fixture',
  livemode: false,
} as const;
const action = {
  reference: 'fixture-action',
  note: 'Synthetic staff action.',
  evidenceReference: 'fixture-case-evidence',
};
const options = (): StaffRefundStoreOptions => ({
  processorEnvironment: environment,
  authorize: async () => ({ id: 'fixture-staff', kind: 'installation-operator' }),
});
function forbiddenDatabase() {
  const connect = vi.fn(async () => {
    throw new Error('No database contact is allowed in this gate test.');
  });
  return { pool: { connect } as unknown as Pool, connect };
}

it('keeps the module closed by default before database or account access', async () => {
  const { pool, connect } = forbiddenDatabase();
  const store = new StaffRefundStore(pool, options());
  await expect(store.snapshot('fixture-workspace', {})).rejects.toMatchObject({
    code: 'staff_refunds_disabled',
  });
  expect(connect).not.toHaveBeenCalled();
});

it('requires an installed trusted staff-authority callback', () => {
  const { pool, connect } = forbiddenDatabase();
  expect(
    () =>
      new StaffRefundStore(pool, {
        processorEnvironment: environment,
        activation: 'fixture',
      } as StaffRefundStoreOptions),
  ).toThrow(/authority callback/i);
  expect(connect).not.toHaveBeenCalled();
});

it('rejects a live-mode environment even with fixture activation', () => {
  const { pool, connect } = forbiddenDatabase();
  expect(
    () =>
      new StaffRefundStore(pool, {
        ...options(),
        activation: 'fixture',
        processorEnvironment: { ...environment, livemode: true },
      }),
  ).toThrow(/trusted processor mode/i);
  expect(connect).not.toHaveBeenCalled();
});

it('does not turn an invalid activation string into an enabled module', () => {
  const { pool, connect } = forbiddenDatabase();
  expect(
    () =>
      new StaffRefundStore(pool, {
        ...options(),
        activation: 'live' as 'fixture',
      }),
  ).toThrow(/not activated/i);
  expect(connect).not.toHaveBeenCalled();
});

it('denies a dispatch mutation without the paid-allocation approval hook', async () => {
  const { pool, connect } = forbiddenDatabase();
  const store = new StaffRefundStore(pool, { ...options(), activation: 'fixture' });
  await expect(store.dispatch(randomUUID(), action, {})).rejects.toMatchObject({ statusCode: 403 });
  expect(connect).not.toHaveBeenCalled();
});

it('never accepts plain JSON as sealed processor success', async () => {
  const { pool, connect } = forbiddenDatabase();
  const store = new StaffRefundStore(pool, {
    ...options(),
    activation: 'fixture',
    approveAllocation: async (_client, _context, request) => ({
      approvalReference: 'fixture-approval',
      requestHash: request.requestHash,
    }),
  });
  await expect(
    store.observeVerifiedProcessorEvidence(
      randomUUID(),
      {} as VerifiedStaffRefundEvidence,
      action,
      {},
    ),
  ).rejects.toMatchObject({ code: 'staff_refund_evidence_unverified' });
  expect(connect).not.toHaveBeenCalled();
});
