// Dispute endpoints.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  uuidParam, openDisputeSchema, changeStatusSchema, addEvidenceSchema, queueQuerySchema,
} from './schemas.js';
import * as service from '../services/disputeService.js';
import * as repo from '../repositories/disputeRepository.js';
import * as reference from '../repositories/referenceRepository.js';
import { deadlineState, daysRemaining } from '../domain/deadlines.js';
import { NotFoundError } from '../lib/errors.js';

export const disputeRouter = Router();

// No try/catch anywhere below: Express 5 catches rejected promises from
// async handlers and routes them to the error middleware automatically.

disputeRouter.post('/', validateBody(openDisputeSchema), async (req, res) => {
  const dispute = await service.openDispute(pool, req.body);
  res.status(201).json({ data: dispute });
});

disputeRouter.get('/queue', validateQuery(queueQuerySchema), async (req, res) => {
  const { limit } = req.validatedQuery;
  const rows = await repo.listOpenDisputesByDeadline(pool, { limit });
  const now = new Date();

  // Deadline state is computed on read, not stored. A stored "is urgent"
  // flag would be wrong the moment the clock moved past it.
  const data = rows.map((d) => ({
    ...d,
    days_remaining: daysRemaining(now, d.respond_by),
    deadline_state: deadlineState(now, d.respond_by, 3),
  }));

  res.json({ data, meta: { count: data.length, generatedAt: now.toISOString() } });
});

disputeRouter.get('/:id', validateParams(uuidParam), async (req, res) => {
  const dispute = await repo.findDisputeById(pool, req.validatedParams.id);
  if (!dispute) throw new NotFoundError(`Dispute ${req.validatedParams.id} not found.`);

  const [events, evidence, transitions] = await Promise.all([
    repo.listEvents(pool, dispute.id),
    repo.listEvidence(pool, dispute.id),
    reference.listStatusTransitions(pool),
  ]);

  // Tell the client which moves are legal from here, so a UI can render
  // exactly the buttons that will work instead of guessing.
  const availableActions = transitions
    .filter((t) => t.from_status === dispute.status_code && t.triggered_by === 'OPERATOR')
    .map((t) => ({
      toStatus: t.to_status,
      requiresEvidence: t.requires_evidence,
      description: t.description,
    }));

  const now = new Date();
  res.json({
    data: {
      ...dispute,
      days_remaining: daysRemaining(now, dispute.respond_by),
      deadline_state: deadlineState(now, dispute.respond_by, 3),
      events,
      evidence,
      availableActions,
    },
  });
});

disputeRouter.post('/:id/status',
  validateParams(uuidParam), validateBody(changeStatusSchema),
  async (req, res) => {
    const updated = await service.changeStatus(pool, {
      disputeId: req.validatedParams.id,
      toStatus: req.body.toStatus,
      triggeredBy: 'OPERATOR',
      actorId: req.body.actorId ?? null,
      note: req.body.note ?? null,
    });
    res.json({ data: updated });
  });

disputeRouter.post('/:id/evidence',
  validateParams(uuidParam), validateBody(addEvidenceSchema),
  async (req, res) => {
    const item = await service.addEvidence(pool, {
      disputeId: req.validatedParams.id,
      kindCode: req.body.kindCode,
      description: req.body.description ?? null,
      fileRef: req.body.fileRef ?? null,
      collectedBy: req.body.collectedBy ?? null,
    });
    res.status(201).json({ data: item });
  });

disputeRouter.get('/:id/evidence-requirements', validateParams(uuidParam), async (req, res) => {
  const dispute = await repo.findDisputeById(pool, req.validatedParams.id);
  if (!dispute) throw new NotFoundError(`Dispute ${req.validatedParams.id} not found.`);

  const requirements = await reference.listEvidenceRequirements(pool, dispute.reason_code_id);
  const collected = await repo.listEvidence(pool, dispute.id);
  const have = new Set(collected.map((e) => e.kind_code));

  res.json({
    data: {
      reasonCode: dispute.reason_code,
      requirements: requirements.map((r) => ({ ...r, satisfied: have.has(r.evidence_kind_code) })),
      missingRequired: requirements
        .filter((r) => r.requirement === 'REQUIRED' && !have.has(r.evidence_kind_code))
        .map((r) => r.evidence_kind_code),
    },
  });
});
