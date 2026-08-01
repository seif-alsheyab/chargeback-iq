// Demo data.
//
// A repository nobody can run is a repository nobody reads. This script
// creates a realistic working set so a stranger can clone, run three
// commands, and see the queue and the compliance report populated.
//
// It deliberately goes through the SERVICE layer rather than raw INSERTs.
// That means every demo dispute obeys the same state machine, deadline
// rules and evidence gates as production traffic -- so the demo data is
// proof the system works, not a hand-built illusion.
//
// Everything it creates is namespaced DEMO and wiped on each run, so it is
// safe to run repeatedly and cannot collide with the APITEST-* scopes used
// by the test suites.

import { pool, closePool } from '../src/db/pool.js';
import * as service from '../src/services/disputeService.js';
import { upsertMonthlyVolume, monthStart, previousMonthStart } from '../src/repositories/volumeRepository.js';

const SCOPE = 'DEMO';
const now = new Date();

function monthsBack(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - n, 1));
}
function hoursAgo(h) {
  return new Date(now.getTime() - h * 3600 * 1000);
}

/** Remove any previous demo run. Same ordering rules as the test cleanup. */
async function wipe() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('chargeback.allow_event_purge','on',true)`);
    const scoped = `
      SELECT d.id FROM disputes d
        JOIN transactions t ON t.id = d.transaction_id
        JOIN merchants m ON m.id = t.merchant_id
       WHERE m.mid LIKE 'DEMO%'`;
    for (const sql of [
      `DELETE FROM webhook_deliveries WHERE dispute_id IN (${scoped})`,
      `DELETE FROM dispute_events WHERE dispute_id IN (${scoped})`,
      `DELETE FROM evidence_items WHERE dispute_id IN (${scoped})`,
      `DELETE FROM disputes WHERE id IN (${scoped})`,
      `DELETE FROM monthly_volumes WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE 'DEMO%')`,
      `DELETE FROM transactions WHERE merchant_id IN (SELECT id FROM merchants WHERE mid LIKE 'DEMO%')`,
      `DELETE FROM merchants WHERE mid LIKE 'DEMO%'`,
      `DELETE FROM operators WHERE email LIKE 'demo-%'`,
    ]) {
      await client.query(sql);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createMerchant({ name, mid, region }) {
  const { rows: [m] } = await pool.query(
    `INSERT INTO merchants (name, mid, region) VALUES ($1,$2,$3) RETURNING *`,
    [name, mid, region]
  );
  return m;
}

async function createOperator(email, fullName, role) {
  const { rows: [o] } = await pool.query(
    `INSERT INTO operators (email, full_name, role) VALUES ($1,$2,$3) RETURNING *`,
    [email, fullName, role]
  );
  return o;
}

async function createTransaction(merchant, i, opts = {}) {
  const { rows: [t] } = await pool.query(
    `INSERT INTO transactions
       (merchant_id, processor_code, network_code, processor_transaction_id,
        amount_minor, currency, is_card_present, avs_result_code, cvv_matched,
        three_ds_authenticated, customer_email, billing_country, shipping_country,
        occurred_at, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING *`,
    [
      merchant.id,
      opts.processor ?? 'STRIPE',
      opts.network ?? 'VISA',
      `${SCOPE}-${merchant.mid}-tx-${i}`,
      opts.amountMinor ?? 25000,
      'USD',
      opts.avs ?? 'Y',
      opts.cvv ?? true,
      opts.threeDS ?? false,
      `customer${i}@example.com`,
      'JO', 'JO',
      hoursAgo(24 * 30),
    ]
  );
  return t;
}

async function run() {
  console.log('wiping any previous demo data');
  await wipe();

  // Two merchants in different regions, because region changes BOTH the
  // response deadline and the VAMP threshold that applies.
  const eu = await createMerchant({ name: 'Northwind Digital (EU)', mid: 'DEMO-EU-001', region: 'EU' });
  const jo = await createMerchant({ name: 'Levant Commerce (CEMEA)', mid: 'DEMO-CEMEA-001', region: 'CEMEA' });

  const analyst = await createOperator('demo-analyst@example.com', 'Demo Analyst', 'ANALYST');
  const manager = await createOperator('demo-manager@example.com', 'Demo Manager', 'MANAGER');

  const created = [];
  let n = 0;

  // --- 1. Fresh cases sitting in the queue, various ages -----------------
  for (const [i, spec] of [
    { reason: '10.4', hours: 2,   amount: 45000 },
    { reason: '13.1', hours: 26,  amount: 12500 },
    { reason: '13.3', hours: 96,  amount: 8900 },
    { reason: '12.6', hours: 340, amount: 30000 },   // close to the 18-day EU line
  ].entries()) {
    const txn = await createTransaction(eu, n++, { amountMinor: spec.amount });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-EU-${String(i + 1).padStart(3, '0')}`,
      transactionId: txn.id,
      reasonCode: spec.reason,
      receivedAt: hoursAgo(spec.hours),
    });
    created.push(d);
  }

  // --- 2. A case fought and won -----------------------------------------
  {
    const txn = await createTransaction(eu, n++, { amountMinor: 62000, threeDS: true });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-EU-WON-001`, transactionId: txn.id,
      reasonCode: '10.4', receivedAt: hoursAgo(24 * 10),
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'UNDER_REVIEW', triggeredBy: 'OPERATOR',
      actorId: analyst.id, note: 'Full AVS and 3DS on file; worth fighting.',
    });
    for (const kind of ['AVS_RESPONSE', 'CVV_RESPONSE', 'THREE_DS_RECORD', 'PRIOR_TRANSACTION_HISTORY']) {
      await service.addEvidence(pool, {
        disputeId: d.id, kindCode: kind, collectedBy: analyst.id,
        description: `Collected for representment (${kind}).`,
      });
    }
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'REPRESENTED', triggeredBy: 'OPERATOR', actorId: analyst.id,
    });
    // The issuer decides, so the trigger is PROCESSOR_EVENT, not OPERATOR.
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'WON', triggeredBy: 'PROCESSOR_EVENT',
      note: 'Issuer accepted the compelling evidence package.',
    });
    created.push(d);
  }

  // --- 3. A case fought and lost ----------------------------------------
  {
    const txn = await createTransaction(eu, n++, { amountMinor: 19900, avs: 'N', cvv: false });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-EU-LOST-001`, transactionId: txn.id,
      reasonCode: '13.1', receivedAt: hoursAgo(24 * 12),
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'UNDER_REVIEW', triggeredBy: 'OPERATOR', actorId: analyst.id,
    });
    await service.addEvidence(pool, {
      disputeId: d.id, kindCode: 'PROOF_OF_SHIPPING', collectedBy: analyst.id,
      description: 'Carrier label only; no signature captured.',
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'REPRESENTED', triggeredBy: 'OPERATOR', actorId: analyst.id,
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'LOST', triggeredBy: 'PROCESSOR_EVENT',
      note: 'No proof of delivery; issuer upheld the dispute.',
    });
    created.push(d);
  }

  // --- 4. A case conceded on purpose ------------------------------------
  {
    const txn = await createTransaction(eu, n++, { amountMinor: 2200 });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-EU-ACCEPTED-001`, transactionId: txn.id,
      reasonCode: '13.6', receivedAt: hoursAgo(24 * 6),
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'UNDER_REVIEW', triggeredBy: 'OPERATOR', actorId: analyst.id,
    });
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'ACCEPTED', triggeredBy: 'OPERATOR', actorId: manager.id,
      note: 'USD 22 case; representment costs more than the disputed amount.',
    });
    created.push(d);
  }

  // --- 5. A case that expired -------------------------------------------
  // EXPIRED is a fact about the clock, so it is applied by SYSTEM. An
  // operator has no transition to it -- that is what stops a tired analyst
  // dressing up "I did not get to it" as "the deadline beat us".
  {
    const txn = await createTransaction(eu, n++, { amountMinor: 15000 });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-EU-EXPIRED-001`, transactionId: txn.id,
      reasonCode: '13.2', receivedAt: hoursAgo(24 * 40),
    });
    await pool.query(
      `UPDATE disputes SET respond_by = $2 WHERE id = $1`,
      [d.id, hoursAgo(24 * 22)]
    );
    await service.changeStatus(pool, {
      disputeId: d.id, toStatus: 'EXPIRED', triggeredBy: 'SYSTEM',
      note: 'Response window closed with no submission.',
    });
    created.push(d);
  }

  // --- 6. Mastercard cases on the CEMEA merchant ------------------------
  for (const [i, reason] of ['4837', '4853', '4855'].entries()) {
    const txn = await createTransaction(jo, n++, { network: 'MASTERCARD', processor: 'CHECKOUT_COM', amountMinor: 40000 });
    const d = await service.openDispute(pool, {
      caseNumber: `${SCOPE}-JO-${String(i + 1).padStart(3, '0')}`,
      transactionId: txn.id, reasonCode: reason,
      receivedAt: hoursAgo(24 * (2 + i * 3)),
    });
    created.push(d);
  }

  // --- 7. Monthly volumes -----------------------------------------------
  // Seeded across three months so both ratio formulas have a denominator
  // whichever month you query. Mastercard divides by the PRIOR month, Visa
  // by the same month -- the reason these are stored per month at all.
  const periods = [monthStart(now), monthsBack(now, 1), monthsBack(now, 2)];
  for (const [idx, period] of periods.entries()) {
    for (const merchant of [eu, jo]) {
      await upsertMonthlyVolume(pool, {
        merchantId: merchant.id, networkCode: 'VISA', periodMonth: period,
        transactionCount: 42000 - idx * 6000,
        cardAbsentCount: 42000 - idx * 6000,
        fraudReportCount: 380 - idx * 40,
      });
      await upsertMonthlyVolume(pool, {
        merchantId: merchant.id, networkCode: 'MASTERCARD', periodMonth: period,
        transactionCount: 9000 - idx * 2500,
        cardAbsentCount: 9000 - idx * 2500,
        fraudReportCount: 60,
      });
    }
  }

  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  console.log('');
  console.log('seeded:');
  console.log(`  merchants   2  (${eu.mid} region EU, ${jo.mid} region CEMEA)`);
  console.log(`  operators   2  (analyst, manager)`);
  console.log(`  disputes    ${created.length}`);
  console.log(`  volumes     ${periods.length * 2 * 2} rows across 3 months`);
  console.log('');
  console.log('try:');
  console.log('  curl -s localhost:4010/api/disputes/queue | jq');
  console.log(`  curl -s "localhost:4010/api/compliance?merchantId=${eu.id}&periodMonth=${fmt(periods[0])}" | jq`);
  console.log(`  curl -s "localhost:4010/api/compliance?merchantId=${jo.id}&periodMonth=${fmt(periods[1])}" | jq`);
  console.log(`  curl -s localhost:4010/api/disputes/${created[0].id} | jq`);
}

run()
  .catch((err) => {
    console.error('\nSEED FAILED\n' + err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
