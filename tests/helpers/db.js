// Integration test helper.
//
// Each test runs inside a transaction that is ALWAYS rolled back. Nothing
// the tests write ever survives, so tests cannot pollute each other and the
// database is identical before and after the suite. No cleanup script, no
// leftover rows, no test that only passes when run first.

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

  return { merchant, txn, reason, dispute, operator };
}
