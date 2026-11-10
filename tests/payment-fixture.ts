import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PaymentStore,
  type CheckoutOrder,
  type CheckoutSession,
  type CreditInTransaction,
  type VerifiedPaymentEvent,
} from '../packages/engine/src/payments.js';

/** Minimal fixture credit callback, not a production accounting implementation.
 * Main integration must additionally test its extracted production helper. */
export const fixtureCredit: CreditInTransaction = async (client, workspace, amount, reference) => {
  await client.query('UPDATE mr_workspaces SET available_micros=available_micros+$2 WHERE id=$1', [
    workspace,
    amount,
  ]);
  await client.query(
    "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference) VALUES($1,$2,'credit',$3,$3,0,$4)",
    [randomUUID(), workspace, amount, reference],
  );
};
export async function paymentFixture(
  options: { max?: number; credit?: CreditInTransaction; now?: () => number } = {},
) {
  const schema = `payment_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: options.max ?? 1,
    options: `-c search_path=${schema}`,
    // Explicit SET also works with PGlite, which ignores startup options.
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
  for (let i = 1; i <= 12; i++) {
    await pool.query(
      await readFile(
        new URL(`../packages/engine/migrations/${String(i).padStart(3, '0')}.sql`, import.meta.url),
        'utf8',
      ),
    );
  }
  // This forward migration only adds manual-order serializer pins and remains
  // valid on the minimal payment schema; billingFixture appends013–025 later.
  await pool.query(
    await readFile(new URL('../packages/engine/migrations/027.sql', import.meta.url), 'utf8'),
  );
  const workspace = `ws_${randomUUID()}`;
  await pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [workspace]);
  const store = new PaymentStore(pool, {
    livemode: false,
    creditInTransaction: options.credit ?? fixtureCredit,
    now: options.now,
  });
  let session: CheckoutSession | undefined;
  const requests: CheckoutOrder[] = [];
  const transport = {
    async createSession(order: CheckoutOrder) {
      requests.push(order);
      session ??= {
        id: `cs_test_${randomUUID().replaceAll('-', '')}`,
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: order.amountCents,
        amount_total: order.amountCents,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: order.id,
        payment_intent: null,
        livemode: false,
        url: 'https://checkout.stripe.com/c/pay/test_fixture',
      };
      return { ...session };
    },
    async retrieveSession(id: string) {
      if (!session || id !== session.id) throw new Error('Unknown fixture session.');
      return { ...session };
    },
  };
  return {
    pool,
    store,
    workspace,
    transport,
    requests,
    session: () => session!,
    setSession: (patch: Partial<CheckoutSession>) => {
      session = { ...session!, ...patch };
    },
    event: (
      type = 'checkout.session.completed',
      patch: Partial<CheckoutSession> = {},
    ): VerifiedPaymentEvent => ({
      id: `evt_${randomUUID()}`,
      type,
      livemode: false,
      data: { object: { ...session!, ...patch } },
    }),
    async paid() {
      session = {
        ...session!,
        status: 'complete',
        payment_status: 'paid',
        payment_intent: `pi_${workspace}`,
      };
    },
    async order() {
      const order = await store.createOrder(workspace, 1000, randomUUID());
      await store.checkout(workspace, order.id, transport);
      return order;
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      // PGlite shares one backend across wire connections, including session settings.
      await admin.query('SET search_path TO public');
      await admin.end();
    },
  };
}
