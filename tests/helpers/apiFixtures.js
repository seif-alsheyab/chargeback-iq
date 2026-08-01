// Fixtures for API tests.
//
// These tests drive real HTTP requests, so they cannot run inside the test's
// own transaction the way the service tests do -- the server uses its own
// pool connection and would never see uncommitted rows. They commit, then
// clean up afterwards.
//
// Cleanup deletes by a recognisable prefix rather than a tracked ID list.
// The API creates rows the test never sees (events, evidence), so tracking
// IDs by hand always misses something. Prefix matching catches everything.
//
// Nothing here swallows errors. A cleanup that hides its own failures lets
// you believe the database is clean when it is not.

import { pool } from '../../src/db/pool.js';

export const TEST_PREFIX = 'APITEST';

export function testTag() {
  return `${TEST_PREFIX}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function seedApiFixtures() {
  const tag = testTag();

  const { rows: [merchant] } = await pool.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,'EU') RETURNING *`,
    [`${TEST_PREFIX} Merchant`, `${tag}-MID`]
  );

  const { rows: [transaction] } = await pool.query(
    `INSERT INTO transactions
       (merchant_id, processor_code, network_code, processor_transaction_id,
        amount_minor, currency, occurred_at)
     VALUES ($1,'STRIPE','VISA',$2,25000,'USD', now() - interval '20 days')
     RETURNING *`,
    [merchant.id, `${tag}-tx`]
  );

  const { rows: [operator] } = await pool.query(
    `INSERT INTO operators (email, full_name, role)
     VALUES ($1,$2,'ANALYST') RETURNING *`,
    [`${tag}@example.test`, `${TEST_PREFIX} Analyst`]
  );

  return { tag, merchant, transaction, operator };
}

/**
 * Remove every row this suite could have created.
 *
 * Two things make this work:
 *
 * 1. Order. Foreign keys force children before parents: events and evidence
 *    point at disputes, disputes at transactions, transactions at merchants.
 *
 * 2. The purge flag. dispute_events refuses DELETE from anyone by default.
 *    set_config('chargeback.allow_event_purge','on',true) authorises it for
 *    THIS transaction only -- the third argument is is_local, so the setting
 *    vanishes at COMMIT or ROLLBACK and cannot leak to another query.
 *
 * Everything runs in one transaction on one client. The flag is per-session,
 * so borrowing a second pool connection midway would silently lose it.
 */
export async function cleanupApiFixtures() {
  const scope = `${TEST_PREFIX}%`;
  const client = await pool.connect();
  const removed = {};

  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('chargeback.allow_event_purge','on',true)`);

    const disputeScope = `
      SELECT d.id FROM disputes d
        JOIN transactions t ON t.id = d.transaction_id
        JOIN merchants m ON m.id = t.merchant_id
       WHERE m.mid LIKE $1`;

    const steps = [
      ['dispute_events', `DELETE FROM dispute_events WHERE dispute_id IN (${disputeScope})`],
      ['evidence_items', `DELETE FROM evidence_items WHERE dispute_id IN (${disputeScope})`],
      ['disputes', `DELETE FROM disputes WHERE id IN (${disputeScope})`],
      ['monthly_volumes', `DELETE FROM monthly_volumes WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE $1)`],
      ['transactions', `DELETE FROM transactions WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE $1)`],
      ['merchants', `DELETE FROM merchants WHERE mid LIKE $1`],
      ['operators', `DELETE FROM operators WHERE email LIKE $1`],
    ];

    for (const [label, sql] of steps) {
      // No catch: if a delete fails, the suite must fail loudly.
      const res = await client.query(sql, [scope]);
      removed[label] = res.rowCount;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return removed;
}

/** Report anything that survived, so the suite can fail on a leak. */
export async function assertNoTestDataRemains() {
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM merchants WHERE mid LIKE $1)   AS merchants,
       (SELECT count(*)::int FROM operators WHERE email LIKE $1) AS operators`,
    [`${TEST_PREFIX}%`]
  );
  return counts;
}
