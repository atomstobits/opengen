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
  await pool.query(`
    ALTER TABLE mr_payment_orders
      DROP CONSTRAINT mr_payment_orders_amount_cents_check,
      DROP CONSTRAINT mr_payment_orders_checkout_request_version_check,
      ADD CONSTRAINT mr_payment_orders_amount_cents_check CHECK (amount_cents BETWEEN 500 AND 999900),
      ADD CONSTRAINT mr_payment_orders_checkout_request_version_check
        CHECK (checkout_request_version IN ('checkout_hosted_v1','checkout_hosted_page_v2','checkout_hosted_page_fee_v3')),
      ADD COLUMN fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
      ADD COLUMN fee_rate_bps integer NOT NULL DEFAULT 0 CHECK (fee_rate_bps IN (0, 290, 440)),
      ADD COLUMN total_charge_cents integer;
    UPDATE mr_payment_orders SET total_charge_cents = amount_cents + fee_cents WHERE total_charge_cents IS NULL;
    ALTER TABLE mr_payment_orders
      ALTER COLUMN total_charge_cents SET NOT NULL,
      ADD CONSTRAINT mr_payment_orders_total_charge_cents_check CHECK (total_charge_cents = amount_cents + fee_cents);
    CREATE FUNCTION mr_billing_total_charge_default() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.total_charge_cents IS NULL AND NEW.fee_cents = 0 AND NEW.amount_cents IS NOT NULL THEN
        NEW.total_charge_cents := NEW.amount_cents;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER mr_payment_orders_total_charge_default BEFORE INSERT ON mr_payment_orders
      FOR EACH ROW EXECUTE FUNCTION mr_billing_total_charge_default();
  `);
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
      const total = order.totalChargeCents ?? order.amountCents;
      session ??= {
        id: `cs_test_${randomUUID().replaceAll('-', '')}`,
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: total,
        amount_total: total,
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
