// Monitoring-programme evaluation.
//
// Visa and Mastercard divide by different things over different periods, so
// each gets its own denominator assembled from the right month.

import { evaluateEcp, evaluateVamp } from '../domain/ratios.js';
import { NotFoundError } from '../lib/errors.js';
import * as volumes from '../repositories/volumeRepository.js';

/**
 * Mastercard ECP: chargebacks THIS month over transactions LAST month.
 * The lag is the whole point -- a drop in sales raises the ratio even when
 * chargeback behaviour has not changed at all.
 */
export async function evaluateMastercardEcp(db, { merchantId, periodMonth }) {
  const priorMonth = volumes.previousMonthStart(periodMonth);

  const chargebackCount = await volumes.countDisputesInMonth(db, {
    merchantId, networkCode: 'MASTERCARD', periodMonth,
  });
  const priorVolume = await volumes.findMonthlyVolume(db, {
    merchantId, networkCode: 'MASTERCARD', periodMonth: priorMonth,
  });

  const result = evaluateEcp({
    chargebackCount,
    priorMonthTransactionCount: priorVolume?.transaction_count ?? 0,
  });

  return {
    ...result,
    merchantId,
    periodMonth,
    denominatorMonth: priorMonth,
    chargebackCount,
    priorMonthTransactionCount: priorVolume?.transaction_count ?? 0,
  };
}

/**
 * Visa VAMP: (fraud reports + disputes) over settled card-absent
 * transactions, both in the SAME month.
 */
export async function evaluateVisaVamp(db, { merchantId, periodMonth, region = 'DEFAULT' }) {
  const disputeCount = await volumes.countDisputesInMonth(db, {
    merchantId, networkCode: 'VISA', periodMonth,
  });
  const volume = await volumes.findMonthlyVolume(db, {
    merchantId, networkCode: 'VISA', periodMonth,
  });

  const result = evaluateVamp({
    fraudReportCount: volume?.fraud_report_count ?? 0,
    disputeCount,
    cardAbsentTransactionCount: volume?.card_absent_count ?? 0,
    region,
  });

  return {
    ...result,
    merchantId,
    periodMonth,
    denominatorMonth: periodMonth,
    disputeCount,
    fraudReportCount: volume?.fraud_report_count ?? 0,
    cardAbsentTransactionCount: volume?.card_absent_count ?? 0,
  };
}

/** Both programmes for one merchant, which is what a manager actually wants. */
export async function evaluateAllProgrammes(db, { merchantId, periodMonth }) {
  const { rows } = await db.query(
    `SELECT id, name, mid, region FROM merchants WHERE id = $1`,
    [merchantId]
  );
  const merchant = rows[0];
  if (!merchant) throw new NotFoundError(`Merchant ${merchantId} not found.`);

  const [visa, mastercard] = await Promise.all([
    evaluateVisaVamp(db, { merchantId, periodMonth, region: merchant.region }),
    evaluateMastercardEcp(db, { merchantId, periodMonth }),
  ]);

  return {
    merchant: { id: merchant.id, name: merchant.name, mid: merchant.mid, region: merchant.region },
    periodMonth,
    programmes: [visa, mastercard],
    anyBreach: [visa, mastercard].some((p) => ['EXCESSIVE', 'ECM', 'HECM'].includes(p.tier)),
  };
}
