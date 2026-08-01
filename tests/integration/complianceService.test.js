import { describe, it, expect, afterAll } from 'vitest';
import { withRollback, seedTransaction } from '../helpers/db.js';
import { closePool } from '../../src/db/pool.js';
import * as compliance from '../../src/services/complianceService.js';
import { upsertMonthlyVolume } from '../../src/repositories/volumeRepository.js';

afterAll(async () => { await closePool(); });

const MAY = new Date(Date.UTC(2026, 4, 1));
const APRIL = new Date(Date.UTC(2026, 3, 1));

/** Create `count` Mastercard disputes received in the given month. */
async function seedDisputes(client, merchantId, networkCode, month, count, reasonCode) {
  const { rows: [reason] } = await client.query(
    `SELECT id FROM reason_codes WHERE network_code=$1 AND code=$2`,
    [networkCode, reasonCode]
  );
  for (let i = 0; i < count; i += 1) {
    const tag = `${networkCode}-${month.getUTCMonth()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows: [txn] } = await client.query(
      `INSERT INTO transactions
         (merchant_id, processor_code, network_code, processor_transaction_id,
          amount_minor, currency, occurred_at)
       VALUES ($1,'STRIPE',$2,$3,5000,'USD',$4) RETURNING id`,
      [merchantId, networkCode, `tx_${tag}`, month]
    );
    await client.query(
      `INSERT INTO disputes
         (case_number, transaction_id, network_code, reason_code_id, status_code,
          disputed_amount_minor, currency, received_at, respond_by)
       VALUES ($1,$2,$3,$4,'CHARGEBACK_RECEIVED',5000,'USD',
                $5::timestamptz, $5::timestamptz + interval '18 days')`,
      [`CB-${tag}`, txn.id, networkCode, reason.id, month]
    );
  }
}

describe('evaluateMastercardEcp', () => {
  it('divides by the PRIOR month, so a sales dip alone can cause a breach', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client);
      // 120 chargebacks FILED in May -- counted by received_at, which is
      // when the chargeback arrived, not when the sale happened.
      await seedDisputes(client, merchant.id, 'MASTERCARD', MAY, 120, '4837');
      // April was quiet: only 6,000 transactions.
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'MASTERCARD',
        periodMonth: APRIL, transactionCount: 6000,
      });

      const result = await compliance.evaluateMastercardEcp(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });

      expect(result.chargebackCount).toBe(120);
      expect(result.priorMonthTransactionCount).toBe(6000);
      expect(result.percent).toBe(2);
      expect(result.tier).toBe('ECM');
      expect(result.denominatorMonth.getUTCMonth()).toBe(3); // April
    });
  });

  it('the same 120 chargebacks are compliant against a busy prior month', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client);
      await seedDisputes(client, merchant.id, 'MASTERCARD', MAY, 120, '4837');
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'MASTERCARD',
        periodMonth: APRIL, transactionCount: 20000,
      });

      const result = await compliance.evaluateMastercardEcp(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });
      expect(result.percent).toBe(0.6);
      expect(result.tier).toBe('COMPLIANT');
    });
  });

  it('reports NOT_ASSESSABLE when the prior month has no recorded volume', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client);
      await seedDisputes(client, merchant.id, 'MASTERCARD', MAY, 5, '4837');
      const result = await compliance.evaluateMastercardEcp(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });
      expect(result.tier).toBe('NOT_ASSESSABLE');
      expect(result.bps).toBeNull();
    });
  });
});

describe('evaluateVisaVamp', () => {
  it('combines fraud reports and disputes over the same month', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client);
      await seedDisputes(client, merchant.id, 'VISA', MAY, 60, '10.4');
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'VISA', periodMonth: MAY,
        transactionCount: 100000, cardAbsentCount: 100000, fraudReportCount: 1940,
      });

      const result = await compliance.evaluateVisaVamp(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });

      expect(result.disputeCount).toBe(60);
      expect(result.events).toBe(2000);
      expect(result.percent).toBe(2);
      expect(result.tier).toBe('EXCESSIVE');
    });
  });

  it('applies the 2.20% CEMEA line, so identical activity passes in Jordan', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client, { region: 'CEMEA' });
      await seedDisputes(client, merchant.id, 'VISA', MAY, 60, '10.4');
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'VISA', periodMonth: MAY,
        transactionCount: 120000, cardAbsentCount: 120000, fraudReportCount: 1740,
      });

      const result = await compliance.evaluateVisaVamp(client, {
        merchantId: merchant.id, periodMonth: MAY, region: 'CEMEA',
      });

      expect(result.percent).toBe(1.5);
      expect(result.thresholdBps).toBe(220);
      expect(result.tier).toBe('COMPLIANT');
    });
  });

  it('exempts a merchant under the 1500-event floor however bad the ratio', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client);
      await seedDisputes(client, merchant.id, 'VISA', MAY, 20, '10.4');
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'VISA', periodMonth: MAY,
        transactionCount: 500, cardAbsentCount: 500, fraudReportCount: 30,
      });

      const result = await compliance.evaluateVisaVamp(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });
      expect(result.tier).toBe('BELOW_FLOOR');
    });
  });
});

describe('evaluateAllProgrammes', () => {
  it('reports both networks and flags any breach', async () => {
    await withRollback(async (client) => {
      const { merchant } = await seedTransaction(client, { region: 'DEFAULT' });
      await seedDisputes(client, merchant.id, 'MASTERCARD', MAY, 150, '4837');
      await upsertMonthlyVolume(client, {
        merchantId: merchant.id, networkCode: 'MASTERCARD',
        periodMonth: APRIL, transactionCount: 5000,
      });

      const report = await compliance.evaluateAllProgrammes(client, {
        merchantId: merchant.id, periodMonth: MAY,
      });

      expect(report.programmes).toHaveLength(2);
      expect(report.programmes.map((p) => p.programme).sort()).toEqual(['ECP', 'VAMP']);
      expect(report.anyBreach).toBe(true);
    });
  });
});
