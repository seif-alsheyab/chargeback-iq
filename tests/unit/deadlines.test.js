import { describe, it, expect } from 'vitest';
import {
  selectDeadlineRule, computeRespondBy, daysRemaining, deadlineState, MS_PER_DAY,
} from '../../src/domain/deadlines.js';
import { ValidationError } from '../../src/lib/errors.js';

const RULES = [
  { network_code: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'DEFAULT', processor_code: null,     response_days: 30, warn_days_before: 5 },
  { network_code: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'US',      processor_code: null,     response_days: 9,  warn_days_before: 3 },
  { network_code: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'EU',      processor_code: null,     response_days: 18, warn_days_before: 4 },
  { network_code: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'EU',      processor_code: 'STRIPE', response_days: 7,  warn_days_before: 2 },
  { network_code: 'MASTERCARD', stage: 'CHARGEBACK_RECEIVED', region: 'DEFAULT', processor_code: null, response_days: 45, warn_days_before: 7 },
];

describe('selectDeadlineRule', () => {
  it('falls back to DEFAULT when the region has no specific rule', () => {
    const r = selectDeadlineRule(RULES, {
      networkCode: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'JO',
    });
    expect(r.response_days).toBe(30);
  });

  it('prefers a region-specific rule over DEFAULT', () => {
    const r = selectDeadlineRule(RULES, {
      networkCode: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'US',
    });
    expect(r.response_days).toBe(9);
  });

  it('prefers a processor-specific rule over a region-only rule', () => {
    const r = selectDeadlineRule(RULES, {
      networkCode: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'EU', processorCode: 'STRIPE',
    });
    expect(r.response_days).toBe(7);
  });

  it('ignores a processor rule when a different processor is in play', () => {
    const r = selectDeadlineRule(RULES, {
      networkCode: 'VISA', stage: 'CHARGEBACK_RECEIVED', region: 'EU', processorCode: 'MYFATOORAH',
    });
    expect(r.response_days).toBe(18);
  });

  it('never mixes networks', () => {
    const r = selectDeadlineRule(RULES, {
      networkCode: 'MASTERCARD', stage: 'CHARGEBACK_RECEIVED', region: 'US',
    });
    expect(r.response_days).toBe(45);
  });

  it('returns null when nothing matches', () => {
    expect(selectDeadlineRule(RULES, {
      networkCode: 'AMEX', stage: 'CHARGEBACK_RECEIVED', region: 'US',
    })).toBeNull();
  });
});

describe('computeRespondBy', () => {
  it('adds the window to the arrival date', () => {
    const received = new Date('2026-03-01T00:00:00Z');
    expect(computeRespondBy(received, 18).toISOString()).toBe('2026-03-19T00:00:00.000Z');
  });

  it('crosses month and year boundaries correctly', () => {
    const received = new Date('2026-12-20T12:00:00Z');
    expect(computeRespondBy(received, 30).toISOString()).toBe('2027-01-19T12:00:00.000Z');
  });

  it('rejects a bad date', () => {
    expect(() => computeRespondBy(new Date('nonsense'), 30)).toThrow(ValidationError);
  });

  it('rejects a zero or negative window', () => {
    expect(() => computeRespondBy(new Date(), 0)).toThrow(ValidationError);
    expect(() => computeRespondBy(new Date(), -5)).toThrow(ValidationError);
  });
});

describe('deadlineState', () => {
  const respondBy = new Date('2026-03-19T00:00:00Z');

  it('is OK with plenty of time left', () => {
    expect(deadlineState(new Date('2026-03-05T00:00:00Z'), respondBy, 4)).toBe('OK');
  });

  it('switches to WARNING once inside the warning window', () => {
    expect(deadlineState(new Date('2026-03-16T00:00:00Z'), respondBy, 4)).toBe('WARNING');
  });

  it('is EXPIRED exactly at the deadline, not a moment later', () => {
    expect(deadlineState(new Date('2026-03-19T00:00:00Z'), respondBy, 4)).toBe('EXPIRED');
  });

  it('stays EXPIRED afterwards', () => {
    expect(deadlineState(new Date('2026-04-01T00:00:00Z'), respondBy, 4)).toBe('EXPIRED');
  });
});

describe('daysRemaining', () => {
  it('counts whole days left', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    expect(daysRemaining(now, new Date(now.getTime() + 5 * MS_PER_DAY))).toBe(5);
  });

  it('goes negative after the deadline passes', () => {
    const now = new Date('2026-03-10T00:00:00Z');
    expect(daysRemaining(now, new Date('2026-03-07T00:00:00Z'))).toBe(-3);
  });
});
