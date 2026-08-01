import { describe, it, expect } from 'vitest';
import {
  toBasisPoints, evaluateEcp, evaluateVamp, VAMP_EVENT_FLOOR,
} from '../../src/domain/ratios.js';
import { ValidationError } from '../../src/lib/errors.js';

describe('toBasisPoints', () => {
  it('converts a ratio to basis points', () => {
    expect(toBasisPoints(120, 6000)).toBe(200);   // 2.00%
    expect(toBasisPoints(150, 10000)).toBe(150);  // 1.50%
  });

  it('returns null rather than dividing by zero', () => {
    expect(toBasisPoints(50, 0)).toBeNull();
  });

  it('rejects negative inputs', () => {
    expect(() => toBasisPoints(-1, 100)).toThrow(ValidationError);
  });
});

describe('evaluateEcp — Mastercard', () => {
  it('uses the PRIOR month as the denominator, which is the trap', () => {
    // 120 chargebacks this month. This month had 10,000 transactions, so a
    // naive 120/10000 reads as a comfortable 1.20%. But last month was quiet
    // at 6,000 transactions, and 120/6000 is 2.00% -- a breach, with no
    // change in chargeback behaviour at all.
    const result = evaluateEcp({ chargebackCount: 120, priorMonthTransactionCount: 6000 });
    expect(result.percent).toBe(2);
    expect(result.tier).toBe('ECM');
  });

  it('stays compliant when the same count sits on a large prior month', () => {
    const result = evaluateEcp({ chargebackCount: 120, priorMonthTransactionCount: 20000 });
    expect(result.percent).toBe(0.6);
    expect(result.tier).toBe('COMPLIANT');
  });

  it('needs BOTH count and ratio — a high ratio on a low count is compliant', () => {
    const result = evaluateEcp({ chargebackCount: 40, priorMonthTransactionCount: 1000 });
    expect(result.percent).toBe(4);          // well over the 1.5% line
    expect(result.tier).toBe('COMPLIANT');   // but only 40 chargebacks
    expect(result.reason).toContain('count is below 100');
  });

  it('needs BOTH — a high count at a low ratio is compliant', () => {
    const result = evaluateEcp({ chargebackCount: 500, priorMonthTransactionCount: 500000 });
    expect(result.tier).toBe('COMPLIANT');
    expect(result.reason).toContain('ratio is below');
  });

  it('escalates to HECM at 300 chargebacks and 3%', () => {
    const result = evaluateEcp({ chargebackCount: 300, priorMonthTransactionCount: 10000 });
    expect(result.percent).toBe(3);
    expect(result.tier).toBe('HECM');
  });

  it('treats the thresholds as inclusive', () => {
    expect(evaluateEcp({ chargebackCount: 100, priorMonthTransactionCount: 6667 }).tier).toBe('ECM');
  });

  it('reports NOT_ASSESSABLE with no prior-month volume', () => {
    expect(evaluateEcp({ chargebackCount: 50, priorMonthTransactionCount: 0 }).tier).toBe('NOT_ASSESSABLE');
  });
});

describe('evaluateVamp — Visa', () => {
  it('counts fraud reports AND disputes in the numerator', () => {
    const result = evaluateVamp({
      fraudReportCount: 800, disputeCount: 1200, cardAbsentTransactionCount: 100000,
    });
    expect(result.events).toBe(2000);
    expect(result.percent).toBe(2);
    expect(result.tier).toBe('EXCESSIVE');
  });

  it('exempts a merchant below the monthly event floor', () => {
    const result = evaluateVamp({
      fraudReportCount: 100, disputeCount: 100, cardAbsentTransactionCount: 1000,
    });
    expect(result.percent).toBe(20);         // ratio is enormous
    expect(result.tier).toBe('BELOW_FLOOR'); // but only 200 events
    expect(result.events).toBeLessThan(VAMP_EVENT_FLOOR);
  });

  it('applies the stricter 1.50% line outside CEMEA', () => {
    const result = evaluateVamp({
      fraudReportCount: 900, disputeCount: 900, cardAbsentTransactionCount: 100000,
    });
    expect(result.percent).toBe(1.8);
    expect(result.tier).toBe('EXCESSIVE');
  });

  it('applies the 2.20% CEMEA line to the same numbers — Jordan and the UAE sit here', () => {
    const result = evaluateVamp({
      fraudReportCount: 900, disputeCount: 900, cardAbsentTransactionCount: 100000, region: 'CEMEA',
    });
    expect(result.percent).toBe(1.8);
    expect(result.tier).toBe('COMPLIANT');   // identical activity, different verdict
  });

  it('treats the excessive line as inclusive', () => {
    const result = evaluateVamp({
      fraudReportCount: 750, disputeCount: 750, cardAbsentTransactionCount: 100000,
    });
    expect(result.percent).toBe(1.5);
    expect(result.tier).toBe('EXCESSIVE');
  });

  it('reports NOT_ASSESSABLE with no card-absent volume', () => {
    const result = evaluateVamp({
      fraudReportCount: 10, disputeCount: 10, cardAbsentTransactionCount: 0,
    });
    expect(result.tier).toBe('NOT_ASSESSABLE');
  });
});
