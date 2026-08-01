import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, closePool } from '../../src/db/pool.js';

const app = createApp();

// The API talks to the real pool, so these tests commit. Everything created
// is tracked and removed afterwards, in reverse dependency order.
const created = { disputes: [], transactions: [], merchants: [], operators: [] };

let merchantId; let transactionId; let operatorId;

beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);

  const { rows: [m] } = await pool.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,'EU') RETURNING id`,
    ['API Test Merchant', `MID-API-${suffix}`]
  );
  merchantId = m.id; created.merchants.push(m.id);

  const { rows: [t] } = await pool.query(
    `INSERT INTO transactions
       (merchant_id, processor_code, network_code, processor_transaction_id,
        amount_minor, currency, occurred_at)
     VALUES ($1,'STRIPE','VISA',$2,25000,'USD', now() - interval '20 days')
     RETURNING id`,
    [merchantId, `tx_api_${suffix}`]
  );
  transactionId = t.id; created.transactions.push(t.id);

  const { rows: [o] } = await pool.query(
    `INSERT INTO operators (email, full_name, role)
     VALUES ($1,'API Analyst','ANALYST') RETURNING id`,
    [`api-${suffix}@example.test`]
  );
  operatorId = o.id; created.operators.push(o.id);
});

afterAll(async () => {
  for (const id of created.disputes) {
    await pool.query('DELETE FROM dispute_events WHERE dispute_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM evidence_items WHERE dispute_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM disputes WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of created.transactions) await pool.query('DELETE FROM transactions WHERE id = $1', [id]).catch(() => {});
  for (const id of created.operators)    await pool.query('DELETE FROM operators WHERE id = $1', [id]).catch(() => {});
  for (const id of created.merchants)    await pool.query('DELETE FROM merchants WHERE id = $1', [id]).catch(() => {});
  await closePool();
});

describe('health and readiness', () => {
  it('reports liveness without touching the database', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports readiness after reaching the database', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('reachable');
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('POST /api/disputes', () => {
  it('opens a dispute and returns 201 with the computed deadline', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(app).post('/api/disputes').send({
      caseNumber: `API-${suffix}`,
      transactionId,
      reasonCode: '10.4',
      receivedAt: '2026-05-01T00:00:00Z',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.status_code).toBe('CHARGEBACK_RECEIVED');
    // EU merchant -> the 18-day compressed window.
    expect(res.body.data.respond_by).toBe('2026-05-19T00:00:00.000Z');
    created.disputes.push(res.body.data.id);
  });

  it('rejects a malformed body with 400 and field-level detail', async () => {
    const res = await request(app).post('/api/disputes').send({
      caseNumber: '', transactionId: 'not-a-uuid', reasonCode: '10.4',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('rejects a float amount, because money is stored in minor units', async () => {
    const res = await request(app).post('/api/disputes').send({
      caseNumber: 'API-FLOAT', transactionId, reasonCode: '10.4',
      disputedAmountMinor: 125.55,
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown transaction', async () => {
    const res = await request(app).post('/api/disputes').send({
      caseNumber: `API-${Math.random().toString(36).slice(2, 8)}`,
      transactionId: '00000000-0000-0000-0000-000000000000',
      reasonCode: '10.4',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('dispute lifecycle over HTTP', () => {
  let disputeId;

  it('opens a case', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(app).post('/api/disputes').send({
      caseNumber: `LIFE-${suffix}`, transactionId, reasonCode: '13.1',
    });
    expect(res.status).toBe(201);
    disputeId = res.body.data.id;
    created.disputes.push(disputeId);
  });

  it('tells the client which actions are legal right now', async () => {
    const res = await request(app).get(`/api/disputes/${disputeId}`);
    expect(res.status).toBe(200);
    const actions = res.body.data.availableActions.map((a) => a.toStatus);
    expect(actions).toEqual(['UNDER_REVIEW']);
  });

  it('reports which required evidence is still missing', async () => {
    const res = await request(app).get(`/api/disputes/${disputeId}/evidence-requirements`);
    expect(res.status).toBe(200);
    expect(res.body.data.missingRequired).toContain('PROOF_OF_DELIVERY');
  });

  it('moves the case into review', async () => {
    const res = await request(app).post(`/api/disputes/${disputeId}/status`)
      .send({ toStatus: 'UNDER_REVIEW', actorId: operatorId, note: 'Picked up' });
    expect(res.status).toBe(200);
    expect(res.body.data.status_code).toBe('UNDER_REVIEW');
  });

  it('refuses representment with no evidence, returning 422', async () => {
    const res = await request(app).post(`/api/disputes/${disputeId}/status`)
      .send({ toStatus: 'REPRESENTED', actorId: operatorId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EVIDENCE_REQUIRED');
  });

  it('accepts evidence', async () => {
    const res = await request(app).post(`/api/disputes/${disputeId}/evidence`)
      .send({ kindCode: 'PROOF_OF_DELIVERY', description: 'DHL POD signed', collectedBy: operatorId });
    expect(res.status).toBe(201);
  });

  it('now allows representment', async () => {
    const res = await request(app).post(`/api/disputes/${disputeId}/status`)
      .send({ toStatus: 'REPRESENTED', actorId: operatorId });
    expect(res.status).toBe(200);
    expect(res.body.data.status_code).toBe('REPRESENTED');
  });

  it('refuses an impossible move with 409', async () => {
    const res = await request(app).post(`/api/disputes/${disputeId}/status`)
      .send({ toStatus: 'UNDER_REVIEW', actorId: operatorId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('shows the full audit trail in order', async () => {
    const res = await request(app).get(`/api/disputes/${disputeId}`);
    const types = res.body.data.events.map((e) => e.event_type);
    expect(types[0]).toBe('DISPUTE_OPENED');
    expect(types).toContain('EVIDENCE_ADDED');
    expect(types.at(-1)).toBe('STATUS_CHANGED');
  });
});

describe('GET /api/disputes/queue', () => {
  it('returns open cases with a deadline state on each', async () => {
    const res = await request(app).get('/api/disputes/queue?limit=10');
    expect(res.status).toBe(200);
    for (const d of res.body.data) {
      expect(['OK', 'WARNING', 'EXPIRED']).toContain(d.deadline_state);
    }
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(app).get('/api/disputes/queue?limit=9999');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/compliance', () => {
  it('returns both programmes for a merchant', async () => {
    const res = await request(app).get(`/api/compliance?merchantId=${merchantId}&periodMonth=2026-05`);
    expect(res.status).toBe(200);
    expect(res.body.data.programmes.map((p) => p.programme).sort()).toEqual(['ECP', 'VAMP']);
  });

  it('rejects a badly formed period', async () => {
    const res = await request(app).get(`/api/compliance?merchantId=${merchantId}&periodMonth=May-2026`);
    expect(res.status).toBe(400);
  });
});

describe('reference data', () => {
  it('exposes the state machine so a client need not hardcode it', async () => {
    const res = await request(app).get('/api/reference/transitions');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(18);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
