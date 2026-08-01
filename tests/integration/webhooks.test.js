import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, closePool } from '../../src/db/pool.js';
import { computeSignature } from '../../src/lib/signature.js';
import { scopeFor, seedApiFixtures, cleanupScope, countRemaining } from '../helpers/apiFixtures.js';

// Own scope, distinct from the HTTP suite, so parallel execution is safe.
const SCOPE = scopeFor('WEBHOOK');
const app = createApp();
const SECRET = process.env.WEBHOOK_SIGNING_SECRET ?? 'replace_me_in_production';
const CASE_NUMBER = `${SCOPE}-CASE-1`;

let transactionExternalId;

beforeAll(async () => {
  await cleanupScope(SCOPE);
  const { transaction } = await seedApiFixtures(SCOPE);
  transactionExternalId = transaction.processor_transaction_id;
});

afterAll(async () => {
  const removed = await cleanupScope(SCOPE);
  const remaining = await countRemaining(SCOPE);
  await closePool();
  if (remaining.merchants !== 0 || remaining.operators !== 0 || remaining.deliveries !== 0) {
    throw new Error(`cleanup incomplete: ${JSON.stringify(remaining)} (removed ${JSON.stringify(removed)})`);
  }
});

function send(body, { secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const raw = JSON.stringify(body);
  const signature = computeSignature({ secret, timestamp, rawBody: raw });
  return request(app)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('x-webhook-timestamp', timestamp)
    .set('x-webhook-signature', signature)
    .send(raw);
}

describe('webhook signature enforcement', () => {
  it('rejects a delivery signed with the wrong secret', async () => {
    const res = await send(
      { id: `${SCOPE}-bad-1`, type: 'dispute.created' },
      { secret: 'attacker_guess' }
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('records the rejected delivery rather than discarding it', async () => {
    const { rows } = await pool.query(
      `SELECT status, signature_valid FROM webhook_deliveries WHERE external_event_id = $1`,
      [`${SCOPE}-bad-1`]
    );
    expect(rows[0].signature_valid).toBe(false);
    expect(rows[0].status).toBe('FAILED');
  });

  it('rejects a replayed delivery from outside the tolerance window', async () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await send({ id: `${SCOPE}-old-1`, type: 'dispute.created' }, { timestamp: oldTs });
    expect(res.status).toBe(401);
  });
});

describe('webhook dispute lifecycle', () => {
  it('opens a dispute from a valid delivery', async () => {
    const res = await send({
      id: `${SCOPE}-open-1`,
      type: 'dispute.created',
      case_number: CASE_NUMBER,
      transaction_id: transactionExternalId,
      reason_code: '10.4',
      amount_minor: 25000,
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('DISPUTE_OPENED');
  });

  it('ignores an exact retry instead of opening a second dispute', async () => {
    const res = await send({
      id: `${SCOPE}-open-1`,          // same event id
      type: 'dispute.created',
      case_number: CASE_NUMBER,
      transaction_id: transactionExternalId,
      reason_code: '10.4',
      amount_minor: 25000,
      currency: 'USD',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('DUPLICATE');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM disputes WHERE case_number = $1`, [CASE_NUMBER]
    );
    expect(rows[0].n).toBe(1);   // still exactly one
  });

  it('ignores an event type it has no handler for', async () => {
    const res = await send({
      id: `${SCOPE}-unknown-1`, type: 'invoice.paid', case_number: CASE_NUMBER,
    });
    expect(res.body.data.outcome).toBe('IGNORED');
  });

  it('records a failure when the referenced case does not exist', async () => {
    const res = await send({
      id: `${SCOPE}-missing-1`, type: 'dispute.won', case_number: `${SCOPE}-DOES-NOT-EXIST`,
    });
    expect(res.status).toBe(200);          // 200 so the processor stops retrying
    expect(res.body.data.outcome).toBe('FAILED');
  });

  it('will not apply a status the state machine forbids from here', async () => {
    // The case is still CHARGEBACK_RECEIVED; WON is only reachable from
    // REPRESENTED or ARBITRATION. A processor cannot talk the system into
    // an impossible state just by asserting it.
    const res = await send({
      id: `${SCOPE}-early-win-1`, type: 'dispute.won', case_number: CASE_NUMBER,
    });
    expect(res.body.data.outcome).toBe('FAILED');

    const { rows } = await pool.query(
      `SELECT status_code FROM disputes WHERE case_number = $1`, [CASE_NUMBER]
    );
    expect(rows[0].status_code).toBe('CHARGEBACK_RECEIVED');
  });

  it('links each processed delivery to the dispute it affected', async () => {
    const { rows } = await pool.query(
      `SELECT external_event_id, status, dispute_id IS NOT NULL AS linked
         FROM webhook_deliveries
        WHERE external_event_id = $1`,
      [`${SCOPE}-open-1`]
    );
    expect(rows[0].status).toBe('PROCESSED');
    expect(rows[0].linked).toBe(true);
  });
});
