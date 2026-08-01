// Service layer: coordinates domain rules and data access.
//
// Repositories know SQL but no rules. Domain functions know rules but no
// SQL. Services are the only place the two meet, and the only place that
// decides what must happen atomically.

import { withTransaction } from '../db/tx.js';
import { assertTransition } from '../domain/lifecycle.js';
import { selectDeadlineRule, computeRespondBy } from '../domain/deadlines.js';
import { NotFoundError, ValidationError, AppError } from '../lib/errors.js';
import * as reference from '../repositories/referenceRepository.js';
import * as disputes from '../repositories/disputeRepository.js';
import * as transactions from '../repositories/transactionRepository.js';

/**
 * Open a new dispute against an existing transaction.
 *
 * The deadline is computed here, once, and stored. It is not recalculated on
 * read: if the rules change next year, cases opened under the old rules keep
 * the deadline they were actually given.
 */
export async function openDispute(pool, input) {
  return withTransaction(pool, async (db) => {
    const context = await transactions.findTransactionContext(db, input.transactionId);
    if (!context) throw new NotFoundError(`Transaction ${input.transactionId} not found.`);

    const reasonCode = await reference.findReasonCode(db, context.network_code, input.reasonCode);
    if (!reasonCode) {
      throw new ValidationError(
        `Reason code ${input.reasonCode} is not valid for ${context.network_code}.`
      );
    }

    const existing = await disputes.findDisputeByCaseNumber(db, input.caseNumber);
    if (existing) {
      throw new ValidationError(`Case number ${input.caseNumber} already exists.`);
    }

    const receivedAt = input.receivedAt ?? new Date();
    const rules = await reference.listDeadlineRules(db);
    const rule = selectDeadlineRule(rules, {
      networkCode: context.network_code,
      stage: 'CHARGEBACK_RECEIVED',
      region: context.merchant_region,
      processorCode: context.processor_code,
    });
    if (!rule) {
      throw new AppError(
        `No deadline rule configured for ${context.network_code} / ${context.merchant_region}.`,
        { status: 500, code: 'MISSING_DEADLINE_RULE' }
      );
    }

    const dispute = await disputes.insertDispute(db, {
      caseNumber: input.caseNumber,
      transactionId: context.id,
      networkCode: context.network_code,
      reasonCodeId: reasonCode.id,
      statusCode: 'CHARGEBACK_RECEIVED',
      rootCause: input.rootCause ?? 'UNDETERMINED',
      cycle: input.cycle ?? 1,
      disputedAmountMinor: input.disputedAmountMinor ?? context.amount_minor,
      currency: input.currency ?? context.currency,
      disputeFeeMinor: input.disputeFeeMinor ?? 0,
      receivedAt,
      respondBy: computeRespondBy(receivedAt, rule.response_days),
      provisionalCreditToCardholderAt: receivedAt,
    });

    await disputes.appendEvent(db, {
      disputeId: dispute.id,
      eventType: 'DISPUTE_OPENED',
      toStatus: 'CHARGEBACK_RECEIVED',
      actorType: 'PROCESSOR_EVENT',
      note: `Opened under ${reasonCode.code} (${reasonCode.title}).`,
      payload: {
        processor: context.processor_code,
        responseDays: rule.response_days,
        warnDaysBefore: rule.warn_days_before,
        workflow: reasonCode.workflow,
      },
    });

    return { ...dispute, reason_code: reasonCode.code, warn_days_before: rule.warn_days_before };
  });
}

/**
 * Move a dispute to a new status.
 *
 * All of this is one transaction: lock, validate, update, record. A status
 * change with no event, or an event with no status change, would corrupt the
 * audit trail -- so neither is allowed to happen alone.
 */
export async function changeStatus(pool, { disputeId, toStatus, triggeredBy, actorId = null, note = null, payload = {} }) {
  return withTransaction(pool, async (db) => {
    const current = await disputes.lockDisputeForUpdate(db, disputeId);
    if (!current) throw new NotFoundError(`Dispute ${disputeId} not found.`);

    const transitions = await reference.listStatusTransitions(db);
    const evidenceCount = await disputes.countEvidence(db, disputeId);

    // Throws InvalidTransitionError or EvidenceRequiredError. Nothing has
    // been written yet, so an invalid request changes nothing at all.
    assertTransition(transitions, {
      from: current.status_code,
      to: toStatus,
      triggeredBy,
      evidenceCount,
    });

    const statuses = await reference.listStatuses(db);
    const target = statuses.find((s) => s.code === toStatus);
    const closedAt = target?.is_terminal ? new Date() : null;

    const updated = await disputes.updateDisputeStatus(db, {
      id: disputeId,
      expectedStatus: current.status_code,
      toStatus,
      closedAt,
    });
    if (!updated) {
      throw new AppError('Dispute changed while this update was in flight.', {
        status: 409, code: 'CONCURRENT_MODIFICATION',
      });
    }

    await disputes.appendEvent(db, {
      disputeId,
      eventType: 'STATUS_CHANGED',
      fromStatus: current.status_code,
      toStatus,
      actorType: triggeredBy,
      actorId,
      note,
      payload: { ...payload, evidenceCount },
    });

    return updated;
  });
}

export async function addEvidence(pool, { disputeId, kindCode, description = null, fileRef = null, collectedBy = null }) {
  return withTransaction(pool, async (db) => {
    const dispute = await disputes.findDisputeById(db, disputeId);
    if (!dispute) throw new NotFoundError(`Dispute ${disputeId} not found.`);
    if (dispute.is_terminal) {
      throw new ValidationError('Cannot attach evidence to a closed dispute.');
    }

    const item = await disputes.insertEvidence(db, {
      disputeId, kindCode, description, fileRef, collectedBy,
    });

    await disputes.appendEvent(db, {
      disputeId,
      eventType: 'EVIDENCE_ADDED',
      actorType: collectedBy ? 'OPERATOR' : 'SYSTEM',
      actorId: collectedBy,
      note: description,
      payload: { kindCode, evidenceId: item.id },
    });

    return item;
  });
}

/**
 * Sweep overdue cases into EXPIRED.
 *
 * Triggered by SYSTEM, never by an operator -- expiry is a fact about the
 * clock, not a decision someone gets to make. Each case is its own
 * transaction so one failure does not block the rest of the queue.
 */
export async function expireOverdueDisputes(pool, now = new Date()) {
  const overdue = await withTransaction(pool, (db) =>
    disputes.listOverdueOpenDisputes(db, now)
  );

  const expired = [];
  const skipped = [];

  for (const d of overdue) {
    try {
      const updated = await changeStatus(pool, {
        disputeId: d.id,
        toStatus: 'EXPIRED',
        triggeredBy: 'SYSTEM',
        note: 'Response window closed with no submission.',
        payload: { respondBy: d.respond_by },
      });
      expired.push(updated.id);
    } catch (err) {
      // A case sitting in REPRESENTED is waiting on the issuer, not on us,
      // so no EXPIRED transition exists from there. Skipping is correct.
      skipped.push({ id: d.id, status: d.status_code, reason: err.code ?? err.message });
    }
  }

  return { expired, skipped, checked: overdue.length };
}
