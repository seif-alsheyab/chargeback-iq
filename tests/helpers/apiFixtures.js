// Fixtures for suites that drive real HTTP requests.
//
// These tests cannot run inside the test's own transaction the way the
// service tests do: the server borrows its own pool connection and would
// never see uncommitted rows. So they COMMIT, then clean up after.
//
// Every suite gets its OWN scope prefix. Vitest runs test files in parallel,
// so a shared prefix means one suite's cleanup deletes another suite's
// fixtures mid-run -- which produces both "row vanished" failures and
// foreign-key violations, because a parallel insert lands between the
// child delete and the parent delete.
//
// Nothing here swallows errors. A cleanup that hides its own failures lets
// you believe the database is clean when it is not.

import { pool } from '../../src/db/pool.js';

export const TEST_PREFIX = 'APITEST';

/** A scope unique to one test file, e.g. scopeFor('WEBHOOK') -> APITEST-WEBHOOK */
export function scopeFor(suite) {
  return `${TEST_PREFIX}-${suite}`;
}

export async function seedApiFixtures(scope) {
  const tag = `${scope}-${Math.random().toString(36).slice(2, 10)}`;

  const { rows: [merchant] } = await pool.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,'EU') RETURNING *`,
    [`${scope} Merchant`, `${tag}-MID`]
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
    [`${tag}@example.test`, `${scope} Analyst`]
  );

  return { tag, merchant, transaction, operator };
}

/**
 * Remove every row this scope could have created.
 *
 * Order is dictated by the foreign keys -- children before parents:
 *   webhook_deliveries -> disputes
 *   dispute_events     -> disputes
 *   evidence_items     -> disputes
 *   disputes           -> transactions -> merchants
 *
 * dispute_events refuses DELETE from anyone by default. set_config with
 * is_local = true authorises the purge for THIS transaction only, so the
 * permission disappears at COMMIT and cannot leak to another query.
 *
 * All of it runs on ONE client inside ONE transaction: the purge flag is
 * per-session, so borrowing a second connection midway would silently lose
 * it and the event delete would fail.
 */
export async function cleanupScope(scope) {
  const like = `${scope}%`;
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
      ['webhook_deliveries',
       `DELETE FROM webhook_deliveries
         WHERE external_event_id LIKE $1 OR dispute_id IN (${disputeScope})`],
      ['dispute_events', `DELETE FROM dispute_events WHERE dispute_id IN (${disputeScope})`],
      ['evidence_items', `DELETE FROM evidence_items WHERE dispute_id IN (${disputeScope})`],
      ['disputes',       `DELETE FROM disputes WHERE id IN (${disputeScope})`],
      ['monthly_volumes',`DELETE FROM monthly_volumes WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE $1)`],
      ['transactions',   `DELETE FROM transactions WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE $1)`],
      ['merchants',      `DELETE FROM merchants WHERE mid LIKE $1`],
      ['operators',      `DELETE FROM operators WHERE email LIKE $1`],
    ];

    for (const [label, sql] of steps) {
      // No catch: if a delete fails, the suite must fail loudly.
      const res = await client.query(sql, [like]);
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

/** Report anything left in this scope, so a suite can fail on a leak. */
export async function countRemaining(scope) {
  const like = `${scope}%`;
  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM merchants WHERE mid LIKE $1)              AS merchants,
       (SELECT count(*)::int FROM operators WHERE email LIKE $1)            AS operators,
       (SELECT count(*)::int FROM webhook_deliveries
          WHERE external_event_id LIKE $1)                                  AS deliveries`,
    [like]
  );
  return counts;
}
