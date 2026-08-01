// Integration test helper.
//
// Each test runs inside a transaction that is ALWAYS rolled back, so nothing
// written by a test survives it.

import { pool } from '../../src/db/pool.js';

export async function withRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Make a single client look like a pool, so service code that opens its own
 * transaction can run inside the test's transaction.
 *
 * Postgres has no true nested BEGIN, but it has SAVEPOINTs: a named marker
 * you can roll back to without ending the outer transaction. So the service's
 * BEGIN becomes SAVEPOINT, its COMMIT becomes RELEASE SAVEPOINT, and its
 * ROLLBACK becomes ROLLBACK TO SAVEPOINT. The service is none the wiser, and
 * the outer ROLLBACK still erases everything.
 */
export function asPool(client) {
  let depth = 0;
  return {
    connect: async () => ({
      query: async (text, params) => {
        const verb = typeof text === 'string' ? text.trim().toUpperCase() : '';
        if (verb === 'BEGIN') {
          depth += 1;
          return client.query(`SAVEPOINT sp_${depth}`);
        }
        if (verb === 'COMMIT') {
          const d = depth;
          depth -= 1;
          return client.query(`RELEASE SAVEPOINT sp_${d}`);
        }
        if (verb === 'ROLLBACK') {
          const d = depth;
          depth -= 1;
          return client.query(`ROLLBACK TO SAVEPOINT sp_${d}`);
        }
        return client.query(text, params);
      },
      release: () => {},
    }),
  };
}

/** Build a merchant + transaction + dispute so a test has something to act on. */
export async function seedDispute(client, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);

  const { rows: [merchant] } = await client.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,$3) RETURNING *`,
    ['Test Merchant', `MID-${suffix}`, overrides.region ?? 'EU']
  );

  const { rows: [txn] } = await client.query(
    `INSERT INTO transactions
       (merchant_id, processor_code, network_code, processor_transaction_id,
        amount_minor, currency, is_card_present, avs_result_code, cvv_matched, occurred_at)
     VALUES ($1,'STRIPE','VISA',$2,$3,'USD',false,'Y',true, now() - interval '30 days')
     RETURNING *`,
    [merchant.id, `tx_${suffix}`, overrides.amountMinor ?? 12500]
  );

  const { rows: [reason] } = await client.query(
    `SELECT id FROM reason_codes WHERE network_code='VISA' AND code=$1`,
    [overrides.reasonCode ?? '10.4']
  );

  const { rows: [dispute] } = await client.query(
    `INSERT INTO disputes
       (case_number, transaction_id, network_code, reason_code_id, status_code,
        disputed_amount_minor, currency, received_at, respond_by)
     VALUES ($1,$2,'VISA',$3,$4,$5,'USD', now(), now() + interval '18 days')
     RETURNING *`,
    [
      `CASE-${suffix}`, txn.id, reason.id,
      overrides.statusCode ?? 'CHARGEBACK_RECEIVED',
      overrides.amountMinor ?? 12500,
    ]
  );

  const { rows: [operator] } = await client.query(
    `INSERT INTO operators (email, full_name, role)
     VALUES ($1,'Test Analyst','ANALYST') RETURNING *`,
    [`analyst-${suffix}@example.test`]
  );

  return { merchant, txn, reason, dispute, operator, suffix };
}

/** A merchant and a bare transaction, for tests that open their own dispute. */
export async function seedTransaction(client, overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);

  const { rows: [merchant] } = await client.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,$3) RETURNING *`,
    ['Test Merchant', `MID-${suffix}`, overrides.region ?? 'EU']
  );

  const { rows: [txn] } = await client.query(
    `INSERT INTO transactions
       (merchant_id, processor_code, network_code, processor_transaction_id,
        amount_minor, currency, is_card_present, occurred_at)
     VALUES ($1,$2,$3,$4,$5,'USD',false, now() - interval '30 days')
     RETURNING *`,
    [
      merchant.id,
      overrides.processorCode ?? 'MYFATOORAH',
      overrides.networkCode ?? 'VISA',
      `tx_${suffix}`,
      overrides.amountMinor ?? 30000,
    ]
  );

  return { merchant, txn, suffix };
}
