import { describe, it, expect, afterAll } from 'vitest';
import { withRollback, seedDispute } from '../helpers/db.js';
import { closePool } from '../../src/db/pool.js';
import {
  listStatusTransitions, listDeadlineRules, findReasonCode, listEvidenceRequirements,
} from '../../src/repositories/referenceRepository.js';
import {
  findDisputeById, updateDisputeStatus, appendEvent, listEvents,
  countEvidence, insertEvidence, listOpenDisputesByDeadline,
} from '../../src/repositories/disputeRepository.js';
import { assertTransition } from '../../src/domain/lifecycle.js';
import { EvidenceRequiredError } from '../../src/lib/errors.js';

afterAll(async () => { await closePool(); });

describe('referenceRepository', () => {
  it('loads the state machine from the database', async () => {
    await withRollback(async (db) => {
      const transitions = await listStatusTransitions(db);
      expect(transitions.length).toBe(18);
      // The same shape the pure functions expect -- this is the seam where
      // real data meets the logic that was unit tested with fake data.
      expect(transitions[0]).toHaveProperty('from_status');
      expect(transitions[0]).toHaveProperty('requires_evidence');
    });
  });

  it('loads deadline rules for both networks', async () => {
    await withRollback(async (db) => {
      const rules = await listDeadlineRules(db);
      expect(rules.length).toBe(9);
      expect(rules.some((r) => r.network_code === 'MASTERCARD')).toBe(true);
    });
  });

  it('finds a reason code and reports whether it counts as fraud', async () => {
    await withRollback(async (db) => {
      const rc = await findReasonCode(db, 'VISA', '10.4');
      expect(rc.title).toContain('Card Absent');
      expect(rc.workflow).toBe('ALLOCATION');
      expect(rc.counts_as_fraud).toBe(true);
    });
  });

  it('returns null for an unknown reason code instead of throwing', async () => {
    await withRollback(async (db) => {
      expect(await findReasonCode(db, 'VISA', '99.9')).toBeNull();
    });
  });

  it('lists evidence requirements with REQUIRED items first', async () => {
    await withRollback(async (db) => {
      const rc = await findReasonCode(db, 'VISA', '13.1');
      const reqs = await listEvidenceRequirements(db, rc.id);
      expect(reqs.length).toBeGreaterThan(0);
      expect(reqs[0].requirement).toBe('REQUIRED');
    });
  });
});

describe('disputeRepository', () => {
  it('reads back a seeded dispute with its reason code joined', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const found = await findDisputeById(db, dispute.id);
      expect(found.reason_code).toBe('10.4');
      expect(found.status_code).toBe('CHARGEBACK_RECEIVED');
      expect(found.is_terminal).toBe(false);
    });
  });

  it('moves a dispute forward when the expected status matches', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const updated = await updateDisputeStatus(db, {
        id: dispute.id, expectedStatus: 'CHARGEBACK_RECEIVED', toStatus: 'UNDER_REVIEW',
      });
      expect(updated.status_code).toBe('UNDER_REVIEW');
    });
  });

  it('refuses the update when the dispute already moved (stale write)', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      await updateDisputeStatus(db, {
        id: dispute.id, expectedStatus: 'CHARGEBACK_RECEIVED', toStatus: 'UNDER_REVIEW',
      });
      // A second operator acting on stale information gets null, not a
      // silent overwrite of someone else's work.
      const second = await updateDisputeStatus(db, {
        id: dispute.id, expectedStatus: 'CHARGEBACK_RECEIVED', toStatus: 'ACCEPTED',
      });
      expect(second).toBeNull();
    });
  });

  it('records events in order and never loses them', async () => {
    await withRollback(async (db) => {
      const { dispute, operator } = await seedDispute(db);
      await appendEvent(db, {
        disputeId: dispute.id, eventType: 'DISPUTE_OPENED',
        toStatus: 'CHARGEBACK_RECEIVED', actorType: 'PROCESSOR_EVENT',
        payload: { processor: 'STRIPE' },
      });
      await appendEvent(db, {
        disputeId: dispute.id, eventType: 'STATUS_CHANGED',
        fromStatus: 'CHARGEBACK_RECEIVED', toStatus: 'UNDER_REVIEW',
        actorType: 'OPERATOR', actorId: operator.id, note: 'Picked up for review',
      });
      const events = await listEvents(db, dispute.id);
      expect(events).toHaveLength(2);
      expect(events[0].event_type).toBe('DISPUTE_OPENED');
      expect(events[0].payload).toEqual({ processor: 'STRIPE' });
      expect(events[1].actor_id).toBe(operator.id);
    });
  });

  it('counts evidence, which is what gates representment', async () => {
    await withRollback(async (db) => {
      const { dispute, operator } = await seedDispute(db);
      expect(await countEvidence(db, dispute.id)).toBe(0);
      await insertEvidence(db, {
        disputeId: dispute.id, kindCode: 'AVS_RESPONSE',
        description: 'Full AVS match, code Y', collectedBy: operator.id,
      });
      expect(await countEvidence(db, dispute.id)).toBe(1);
    });
  });

  it('orders the work queue by soonest deadline', async () => {
    await withRollback(async (db) => {
      await seedDispute(db);
      await seedDispute(db);
      const queue = await listOpenDisputesByDeadline(db, { limit: 10 });
      expect(queue.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < queue.length; i += 1) {
        expect(queue[i].respond_by.getTime()).toBeGreaterThanOrEqual(
          queue[i - 1].respond_by.getTime()
        );
      }
    });
  });
});

describe('real transitions applied to a real dispute', () => {
  it('blocks representment with no evidence, then allows it once evidence exists', async () => {
    await withRollback(async (db) => {
      const { dispute, operator } = await seedDispute(db, { statusCode: 'UNDER_REVIEW' });
      const transitions = await listStatusTransitions(db);

      // Same pure function as the unit tests -- now fed the real table.
      expect(() => assertTransition(transitions, {
        from: 'UNDER_REVIEW', to: 'REPRESENTED', triggeredBy: 'OPERATOR',
        evidenceCount: 0,
      })).toThrow(EvidenceRequiredError);

      await insertEvidence(db, {
        disputeId: dispute.id, kindCode: 'PROOF_OF_DELIVERY', collectedBy: operator.id,
      });
      const count = await countEvidence(db, dispute.id);

      expect(() => assertTransition(transitions, {
        from: 'UNDER_REVIEW', to: 'REPRESENTED', triggeredBy: 'OPERATOR',
        evidenceCount: count,
      })).not.toThrow();
    });
  });
});
