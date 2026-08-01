import { describe, it, expect, afterAll } from 'vitest';
import { withRollback, asPool, seedDispute, seedTransaction } from '../helpers/db.js';
import { closePool } from '../../src/db/pool.js';
import * as service from '../../src/services/disputeService.js';
import { listEvents, findDisputeById } from '../../src/repositories/disputeRepository.js';
import { EvidenceRequiredError, InvalidTransitionError, NotFoundError, ValidationError } from '../../src/lib/errors.js';

afterAll(async () => { await closePool(); });

describe('openDispute', () => {
  it('computes the deadline from the merchant region, not a hardcoded number', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { txn, suffix } = await seedTransaction(client, { region: 'EU' });

      const dispute = await service.openDispute(db, {
        caseNumber: `CB-${suffix}`,
        transactionId: txn.id,
        reasonCode: '10.4',
        receivedAt: new Date('2026-05-01T00:00:00Z'),
      });

      // EU rule is 18 days, so 1 May + 18 = 19 May. A US merchant would get
      // 9 days and a merchant in an unlisted region would get the 30-day
      // network baseline.
      expect(dispute.respond_by.toISOString()).toBe('2026-05-19T00:00:00.000Z');
      expect(dispute.status_code).toBe('CHARGEBACK_RECEIVED');
    });
  });

  it('gives a US merchant the compressed 9-day window for the same reason code', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { txn, suffix } = await seedTransaction(client, { region: 'US' });

      const dispute = await service.openDispute(db, {
        caseNumber: `CB-${suffix}`,
        transactionId: txn.id,
        reasonCode: '10.4',
        receivedAt: new Date('2026-05-01T00:00:00Z'),
      });

      expect(dispute.respond_by.toISOString()).toBe('2026-05-10T00:00:00.000Z');
    });
  });

  it('writes the opening event so the case has a history from birth', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { txn, suffix } = await seedTransaction(client);

      const dispute = await service.openDispute(db, {
        caseNumber: `CB-${suffix}`, transactionId: txn.id, reasonCode: '13.1',
      });

      const events = await listEvents(client, dispute.id);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('DISPUTE_OPENED');
      expect(events[0].actor_type).toBe('PROCESSOR_EVENT');
      expect(events[0].payload.workflow).toBe('COLLABORATION');
    });
  });

  it('rejects a reason code that does not belong to the network', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { txn, suffix } = await seedTransaction(client, { networkCode: 'VISA' });
      // 4837 is a Mastercard code; this transaction is Visa.
      await expect(service.openDispute(db, {
        caseNumber: `CB-${suffix}`, transactionId: txn.id, reasonCode: '4837',
      })).rejects.toThrow(ValidationError);
    });
  });

  it('rejects a duplicate case number', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { txn, suffix } = await seedTransaction(client);
      await service.openDispute(db, {
        caseNumber: `CB-${suffix}`, transactionId: txn.id, reasonCode: '10.4',
      });
      await expect(service.openDispute(db, {
        caseNumber: `CB-${suffix}`, transactionId: txn.id, reasonCode: '10.4',
      })).rejects.toThrow(ValidationError);
    });
  });

  it('rejects an unknown transaction', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      await expect(service.openDispute(db, {
        caseNumber: 'CB-NOPE',
        transactionId: '00000000-0000-0000-0000-000000000000',
        reasonCode: '10.4',
      })).rejects.toThrow(NotFoundError);
    });
  });
});

describe('changeStatus', () => {
  it('moves a case into review and records who did it', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client);

      const updated = await service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'UNDER_REVIEW',
        triggeredBy: 'OPERATOR', actorId: operator.id, note: 'Picked up',
      });

      expect(updated.status_code).toBe('UNDER_REVIEW');
      const events = await listEvents(client, dispute.id);
      expect(events.at(-1).actor_id).toBe(operator.id);
    });
  });

  it('refuses to skip review and go straight to representment', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client);
      await expect(service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'REPRESENTED',
        triggeredBy: 'OPERATOR', actorId: operator.id,
      })).rejects.toThrow(InvalidTransitionError);
    });
  });

  it('blocks representment with no evidence, and CHANGES NOTHING when it does', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client, { statusCode: 'UNDER_REVIEW' });

      await expect(service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'REPRESENTED',
        triggeredBy: 'OPERATOR', actorId: operator.id,
      })).rejects.toThrow(EvidenceRequiredError);

      // The rejection must leave no trace: same status, no event written.
      const after = await findDisputeById(client, dispute.id);
      expect(after.status_code).toBe('UNDER_REVIEW');
      expect(await listEvents(client, dispute.id)).toHaveLength(0);
    });
  });

  it('allows representment once evidence is attached', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client, { statusCode: 'UNDER_REVIEW' });

      await service.addEvidence(db, {
        disputeId: dispute.id, kindCode: 'AVS_RESPONSE',
        description: 'Full match, code Y', collectedBy: operator.id,
      });

      const updated = await service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'REPRESENTED',
        triggeredBy: 'OPERATOR', actorId: operator.id,
      });
      expect(updated.status_code).toBe('REPRESENTED');
    });
  });

  it('stamps closed_at when the case reaches a terminal state', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client, { statusCode: 'UNDER_REVIEW' });

      const accepted = await service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'ACCEPTED',
        triggeredBy: 'OPERATOR', actorId: operator.id,
        note: 'Amount below the cost of fighting',
      });

      expect(accepted.closed_at).not.toBeNull();
    });
  });

  it('will not reopen a closed case', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client, { statusCode: 'UNDER_REVIEW' });
      await service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'ACCEPTED',
        triggeredBy: 'OPERATOR', actorId: operator.id,
      });
      await expect(service.changeStatus(db, {
        disputeId: dispute.id, toStatus: 'UNDER_REVIEW',
        triggeredBy: 'OPERATOR', actorId: operator.id,
      })).rejects.toThrow(InvalidTransitionError);
    });
  });
});

describe('addEvidence', () => {
  it('records an event alongside the evidence item', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client);
      await service.addEvidence(db, {
        disputeId: dispute.id, kindCode: 'PROOF_OF_DELIVERY', collectedBy: operator.id,
      });
      const events = await listEvents(client, dispute.id);
      expect(events.at(-1).event_type).toBe('EVIDENCE_ADDED');
    });
  });

  it('refuses evidence on a closed case', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute, operator } = await seedDispute(client, { statusCode: 'WON' });
      await expect(service.addEvidence(db, {
        disputeId: dispute.id, kindCode: 'AVS_RESPONSE', collectedBy: operator.id,
      })).rejects.toThrow(ValidationError);
    });
  });
});

describe('expireOverdueDisputes', () => {
  it('expires an overdue case as SYSTEM, never as an operator', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute } = await seedDispute(client);
      await client.query(
        // received_at must move back as well: the table enforces
        // CHECK (respond_by > received_at), so a deadline in the past
        // is only valid if the case arrived even further in the past.
        `UPDATE disputes
            SET received_at = now() - interval '30 days',
                respond_by  = now() - interval '1 day'
          WHERE id = $1`,
        [dispute.id]
      );

      const result = await service.expireOverdueDisputes(db, new Date());

      expect(result.expired).toContain(dispute.id);
      const after = await findDisputeById(client, dispute.id);
      expect(after.status_code).toBe('EXPIRED');
      expect(after.closed_at).not.toBeNull();

      const events = await listEvents(client, dispute.id);
      expect(events.at(-1).actor_type).toBe('SYSTEM');
      expect(events.at(-1).actor_id).toBeNull();
    });
  });

  it('skips a represented case, because the wait is on the issuer not on us', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute } = await seedDispute(client, { statusCode: 'REPRESENTED' });
      await client.query(
        // received_at must move back as well: the table enforces
        // CHECK (respond_by > received_at), so a deadline in the past
        // is only valid if the case arrived even further in the past.
        `UPDATE disputes
            SET received_at = now() - interval '30 days',
                respond_by  = now() - interval '1 day'
          WHERE id = $1`,
        [dispute.id]
      );

      const result = await service.expireOverdueDisputes(db, new Date());

      expect(result.expired).not.toContain(dispute.id);
      expect(result.skipped.some((s) => s.id === dispute.id)).toBe(true);
      const after = await findDisputeById(client, dispute.id);
      expect(after.status_code).toBe('REPRESENTED');
    });
  });

  it('leaves cases inside their window alone', async () => {
    await withRollback(async (client) => {
      const db = asPool(client);
      const { dispute } = await seedDispute(client);
      const result = await service.expireOverdueDisputes(db, new Date());
      expect(result.expired).not.toContain(dispute.id);
    });
  });
});
