import { describe, it, expect } from 'vitest';
import {
  findTransition, canTransition, nextStatuses, isTerminal, assertTransition,
} from '../../src/domain/lifecycle.js';
import { InvalidTransitionError, EvidenceRequiredError } from '../../src/lib/errors.js';

// A small stand-in for the status_transitions table. Because the functions
// take transitions as an argument, the test needs no database at all.
const TRANSITIONS = [
  { from_status: 'CHARGEBACK_RECEIVED', to_status: 'UNDER_REVIEW',    triggered_by: 'OPERATOR',        requires_evidence: false },
  { from_status: 'CHARGEBACK_RECEIVED', to_status: 'EXPIRED',         triggered_by: 'SYSTEM',          requires_evidence: false },
  { from_status: 'UNDER_REVIEW',        to_status: 'ACCEPTED',        triggered_by: 'OPERATOR',        requires_evidence: false },
  { from_status: 'UNDER_REVIEW',        to_status: 'REPRESENTED',     triggered_by: 'OPERATOR',        requires_evidence: true  },
  { from_status: 'REPRESENTED',         to_status: 'WON',             triggered_by: 'PROCESSOR_EVENT', requires_evidence: false },
  { from_status: 'REPRESENTED',         to_status: 'LOST',            triggered_by: 'PROCESSOR_EVENT', requires_evidence: false },
];

describe('findTransition', () => {
  it('returns the row for a permitted move', () => {
    const t = findTransition(TRANSITIONS, {
      from: 'CHARGEBACK_RECEIVED', to: 'UNDER_REVIEW', triggeredBy: 'OPERATOR',
    });
    expect(t).not.toBeNull();
    expect(t.requires_evidence).toBe(false);
  });

  it('returns null for a move that is not in the table', () => {
    const t = findTransition(TRANSITIONS, {
      from: 'CHARGEBACK_RECEIVED', to: 'WON', triggeredBy: 'OPERATOR',
    });
    expect(t).toBeNull();
  });

  it('treats the trigger as part of the identity of a move', () => {
    // The same from/to is legal for SYSTEM but not for an operator: an
    // operator must not be able to mark a case expired by hand.
    expect(canTransition(TRANSITIONS, {
      from: 'CHARGEBACK_RECEIVED', to: 'EXPIRED', triggeredBy: 'SYSTEM',
    })).toBe(true);
    expect(canTransition(TRANSITIONS, {
      from: 'CHARGEBACK_RECEIVED', to: 'EXPIRED', triggeredBy: 'OPERATOR',
    })).toBe(false);
  });
});

describe('nextStatuses', () => {
  it('lists every onward move from a status', () => {
    const next = nextStatuses(TRANSITIONS, 'UNDER_REVIEW').map((n) => n.status).sort();
    expect(next).toEqual(['ACCEPTED', 'REPRESENTED']);
  });

  it('returns an empty list for a status with no exits', () => {
    expect(nextStatuses(TRANSITIONS, 'WON')).toEqual([]);
  });
});

describe('isTerminal', () => {
  it('recognises an end state', () => {
    expect(isTerminal(TRANSITIONS, 'WON')).toBe(true);
    expect(isTerminal(TRANSITIONS, 'LOST')).toBe(true);
  });

  it('does not mark an in-progress status as terminal', () => {
    expect(isTerminal(TRANSITIONS, 'UNDER_REVIEW')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('allows a valid move and hands back the transition', () => {
    const t = assertTransition(TRANSITIONS, {
      from: 'UNDER_REVIEW', to: 'ACCEPTED', triggeredBy: 'OPERATOR',
    });
    expect(t.to_status).toBe('ACCEPTED');
  });

  it('rejects a move that skips review', () => {
    expect(() => assertTransition(TRANSITIONS, {
      from: 'CHARGEBACK_RECEIVED', to: 'REPRESENTED', triggeredBy: 'OPERATOR',
    })).toThrow(InvalidTransitionError);
  });

  it('rejects representment with no evidence attached', () => {
    expect(() => assertTransition(TRANSITIONS, {
      from: 'UNDER_REVIEW', to: 'REPRESENTED', triggeredBy: 'OPERATOR', evidenceCount: 0,
    })).toThrow(EvidenceRequiredError);
  });

  it('allows representment once evidence exists', () => {
    const t = assertTransition(TRANSITIONS, {
      from: 'UNDER_REVIEW', to: 'REPRESENTED', triggeredBy: 'OPERATOR', evidenceCount: 3,
    });
    expect(t.requires_evidence).toBe(true);
  });

  it('does not require evidence to give up', () => {
    expect(() => assertTransition(TRANSITIONS, {
      from: 'UNDER_REVIEW', to: 'ACCEPTED', triggeredBy: 'OPERATOR', evidenceCount: 0,
    })).not.toThrow();
  });

  it('refuses to move a case out of a terminal state', () => {
    expect(() => assertTransition(TRANSITIONS, {
      from: 'WON', to: 'UNDER_REVIEW', triggeredBy: 'OPERATOR',
    })).toThrow(InvalidTransitionError);
  });
});
