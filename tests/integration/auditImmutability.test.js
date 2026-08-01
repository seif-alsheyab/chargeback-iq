import { describe, it, expect, afterAll } from 'vitest';
import { withRollback, seedDispute } from '../helpers/db.js';
import { closePool } from '../../src/db/pool.js';
import { appendEvent } from '../../src/repositories/disputeRepository.js';

afterAll(async () => { await closePool(); });

// The append-only guarantee is the backbone of the audit trail, so it gets
// its own tests. Two things must both hold: ordinary code cannot mutate an
// event, and an explicitly authorised purge can.

describe('dispute_events immutability', () => {
  it('rejects UPDATE from ordinary application code', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const event = await appendEvent(db, {
        disputeId: dispute.id, eventType: 'TEST', actorType: 'SYSTEM',
      });
      await expect(
        db.query(`UPDATE dispute_events SET event_type = 'tampered' WHERE id = $1`, [event.id])
      ).rejects.toThrow(/append-only/);
    });
  });

  it('rejects DELETE from ordinary application code', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const event = await appendEvent(db, {
        disputeId: dispute.id, eventType: 'TEST', actorType: 'SYSTEM',
      });
      await expect(
        db.query(`DELETE FROM dispute_events WHERE id = $1`, [event.id])
      ).rejects.toThrow(/append-only/);
    });
  });

  it('allows a purge only when explicitly authorised in the same transaction', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const event = await appendEvent(db, {
        disputeId: dispute.id, eventType: 'TEST', actorType: 'SYSTEM',
      });

      await db.query(`SELECT set_config('chargeback.allow_event_purge','on',true)`);
      const res = await db.query(`DELETE FROM dispute_events WHERE id = $1`, [event.id]);
      expect(res.rowCount).toBe(1);
    });
  });

  it('blocks again once the flag is turned off', async () => {
    await withRollback(async (db) => {
      const { dispute } = await seedDispute(db);
      const event = await appendEvent(db, {
        disputeId: dispute.id, eventType: 'TEST', actorType: 'SYSTEM',
      });

      await db.query(`SELECT set_config('chargeback.allow_event_purge','on',true)`);
      await db.query(`SELECT set_config('chargeback.allow_event_purge','off',true)`);

      await expect(
        db.query(`DELETE FROM dispute_events WHERE id = $1`, [event.id])
      ).rejects.toThrow(/append-only/);
    });
  });
});
