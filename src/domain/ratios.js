// Monitoring-programme ratios.
//
// Visa and Mastercard do NOT compute "the chargeback rate" the same way.
// Storing one blended number would be wrong for both, so each programme
// gets its own calculator.
//
//   Mastercard ECP : chargebacks this month / transactions LAST month.
//                    A quiet sales month can push the ratio up on its own.
//   Visa VAMP      : (fraud reports + disputes) / settled card-absent
//                    transactions in the SAME month. One transaction can
//                    count twice if it is both reported as fraud and
//                    disputed.
//
// Everything below is expressed in basis points (bps). 1% = 100 bps.
// Integers avoid the rounding surprises of comparing floats near a limit.

import { ValidationError } from '../lib/errors.js';

export const ECP_THRESHOLDS = {
  ECM: { minCount: 100, minBps: 150 },
  HECM: { minCount: 300, minBps: 300 },
};

// Merchant Excessive line, in force since 1 April 2026. CEMEA — which is
// where Jordan and the UAE sit — was left at the older 2.20%.
export const VAMP_MERCHANT_BPS = { DEFAULT: 150, CEMEA: 220 };

// A merchant is only assessed above this many combined events per month.
export const VAMP_EVENT_FLOOR = 1500;

/** Ratio in basis points, or null when there is nothing to divide by. */
export function toBasisPoints(numerator, denominator) {
  if (!Number.isFinite(numerator) || numerator < 0) {
    throw new ValidationError('numerator must be a non-negative number.');
  }
  if (!Number.isFinite(denominator) || denominator < 0) {
    throw new ValidationError('denominator must be a non-negative number.');
  }
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000);
}

export function bpsToPercent(bps) {
  return bps === null ? null : bps / 100;
}

/**
 * Mastercard Excessive Chargeback Program.
 *
 * Both conditions must be true: the raw count AND the ratio. A merchant
 * with 2000 chargebacks on a huge volume can stay compliant, and a merchant
 * with 120 chargebacks on a small volume can breach.
 */
export function evaluateEcp({ chargebackCount, priorMonthTransactionCount }) {
  const bps = toBasisPoints(chargebackCount, priorMonthTransactionCount);

  if (bps === null) {
    return { programme: 'ECP', tier: 'NOT_ASSESSABLE', bps: null, percent: null,
             reason: 'No transactions in the prior month, so the ratio has no denominator.' };
  }

  const { ECM, HECM } = ECP_THRESHOLDS;

  if (chargebackCount >= HECM.minCount && bps >= HECM.minBps) {
    return { programme: 'ECP', tier: 'HECM', bps, percent: bpsToPercent(bps),
             reason: `${chargebackCount} chargebacks at ${bpsToPercent(bps)}% meets both HECM conditions.` };
  }

  if (chargebackCount >= ECM.minCount && bps >= ECM.minBps) {
    return { programme: 'ECP', tier: 'ECM', bps, percent: bpsToPercent(bps),
             reason: `${chargebackCount} chargebacks at ${bpsToPercent(bps)}% meets both ECM conditions.` };
  }

  const failed = chargebackCount < ECM.minCount ? 'count is below 100' : 'ratio is below 1.50%';
  return { programme: 'ECP', tier: 'COMPLIANT', bps, percent: bpsToPercent(bps),
           reason: `Not in the programme: ${failed}.` };
}

/**
 * Visa Acquirer Monitoring Program.
 *
 * Numerator combines fraud reports and disputes. Denominator is settled
 * card-absent transactions in the same period.
 */
export function evaluateVamp({ fraudReportCount, disputeCount, cardAbsentTransactionCount, region = 'DEFAULT' }) {
  const events = fraudReportCount + disputeCount;
  const bps = toBasisPoints(events, cardAbsentTransactionCount);
  const thresholdBps = VAMP_MERCHANT_BPS[region] ?? VAMP_MERCHANT_BPS.DEFAULT;

  if (bps === null) {
    return { programme: 'VAMP', tier: 'NOT_ASSESSABLE', bps: null, percent: null, events, thresholdBps,
             reason: 'No settled card-absent transactions, so the ratio has no denominator.' };
  }

  if (events < VAMP_EVENT_FLOOR) {
    return { programme: 'VAMP', tier: 'BELOW_FLOOR', bps, percent: bpsToPercent(bps), events, thresholdBps,
             reason: `${events} combined events is under the ${VAMP_EVENT_FLOOR} monthly floor for assessment.` };
  }

  if (bps >= thresholdBps) {
    return { programme: 'VAMP', tier: 'EXCESSIVE', bps, percent: bpsToPercent(bps), events, thresholdBps,
             reason: `${bpsToPercent(bps)}% is at or above the ${bpsToPercent(thresholdBps)}% ${region} excessive line.` };
  }

  return { programme: 'VAMP', tier: 'COMPLIANT', bps, percent: bpsToPercent(bps), events, thresholdBps,
           reason: `${bpsToPercent(bps)}% is below the ${bpsToPercent(thresholdBps)}% ${region} excessive line.` };
}
