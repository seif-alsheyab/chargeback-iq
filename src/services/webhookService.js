// Webhook processing.
//
// Three separate protections, each covering a different failure:
//   signature   -> the delivery really came from the processor
//   timestamp   -> it is not an old capture being replayed
//   idempotency -> a legitimate retry does not create a second dispute
//
// A delivery is recorded BEFORE it is acted on. If processing then crashes,
// the record survives with status FAILED and the error attached, so nothing
// vanishes silently.

import { withTransaction } from '../db/tx.js';
import { ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import * as webhooks from '../repositories/webhookRepository.js';
import * as transactions from '../repositories/transactionRepository.js';
import * as disputeRepo from '../repositories/disputeRepository.js';
import * as service from './disputeService.js';

/** Map a processor's event name onto a dispute status we understand. */
const EVENT_TO_STATUS = {
  'dispute.created': null,               // handled as "open a new dispute"
  'dispute.won': 'WON',
  'dispute.lost': 'LOST',
  'dispute.withdrawn': 'WITHDRAWN',
  'dispute.pre_arbitration': 'PRE_ARBITRATION',
};

export async function processDelivery(pool, { processorCode, externalEventId, eventType, payload, signatureValid }) {
  // Record first. An unsigned delivery is still recorded -- refusing to log
  // it would hide an attack in progress.
  const delivery = await withTransaction(pool, (db) =>
    webhooks.recordDelivery(db, {
      processorCode, externalEventId, eventType, payload, signatureValid,
    })
  );

  if (delivery === null) {
    const existing = await webhooks.findDelivery(pool, processorCode, externalEventId);
    logger.info('duplicate webhook ignored', { processorCode, externalEventId });
    return { outcome: 'DUPLICATE', delivery: existing };
  }

  if (!signatureValid) {
    const marked = await withTransaction(pool, (db) =>
      webhooks.markDelivery(db, {
        id: delivery.id, status: 'FAILED', errorMessage: 'Signature verification failed.',
      })
    );
    logger.warn('webhook signature invalid', { processorCode, externalEventId });
    return { outcome: 'REJECTED', delivery: marked };
  }

  try {
    if (eventType === 'dispute.created') {
      const transaction = await transactions.findTransactionByProcessorId(
        pool, processorCode, payload.transaction_id
      );
      if (!transaction) {
        throw new ValidationError(
          `Unknown transaction ${payload.transaction_id} for ${processorCode}.`
        );
      }

      const dispute = await service.openDispute(pool, {
        caseNumber: payload.case_number,
        transactionId: transaction.id,
        reasonCode: payload.reason_code,
        disputedAmountMinor: payload.amount_minor,
        currency: payload.currency,
        receivedAt: payload.received_at ? new Date(payload.received_at) : new Date(),
      });

      const marked = await withTransaction(pool, (db) =>
        webhooks.markDelivery(db, { id: delivery.id, status: 'PROCESSED', disputeId: dispute.id })
      );
      return { outcome: 'DISPUTE_OPENED', delivery: marked, dispute };
    }

    const toStatus = EVENT_TO_STATUS[eventType];
    if (!toStatus) {
      const marked = await withTransaction(pool, (db) =>
        webhooks.markDelivery(db, {
          id: delivery.id, status: 'IGNORED',
          errorMessage: `No handler for event type ${eventType}.`,
        })
      );
      return { outcome: 'IGNORED', delivery: marked };
    }

    const dispute = await disputeRepo.findDisputeByCaseNumber(pool, payload.case_number);
    if (!dispute) {
      throw new ValidationError(`No dispute with case number ${payload.case_number}.`);
    }

    // PROCESSOR_EVENT, never OPERATOR: the issuer decided this, not us.
    const updated = await service.changeStatus(pool, {
      disputeId: dispute.id,
      toStatus,
      triggeredBy: 'PROCESSOR_EVENT',
      note: `Processor reported ${eventType}.`,
      payload: { externalEventId, processorCode },
    });

    const marked = await withTransaction(pool, (db) =>
      webhooks.markDelivery(db, { id: delivery.id, status: 'PROCESSED', disputeId: dispute.id })
    );
    return { outcome: 'STATUS_CHANGED', delivery: marked, dispute: updated };
  } catch (err) {
    const marked = await withTransaction(pool, (db) =>
      webhooks.markDelivery(db, {
        id: delivery.id, status: 'FAILED', errorMessage: err.message,
      })
    );
    logger.error('webhook processing failed', {
      processorCode, externalEventId, eventType, message: err.message,
    });
    return { outcome: 'FAILED', delivery: marked, error: err };
  }
}
