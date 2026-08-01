// Read-only reference data, so a client can populate dropdowns and
// understand the rules without hardcoding them.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import * as reference from '../repositories/referenceRepository.js';

export const referenceRouter = Router();

referenceRouter.get('/statuses', async (_req, res) => {
  res.json({ data: await reference.listStatuses(pool) });
});

referenceRouter.get('/transitions', async (_req, res) => {
  res.json({ data: await reference.listStatusTransitions(pool) });
});

referenceRouter.get('/deadline-rules', async (_req, res) => {
  res.json({ data: await reference.listDeadlineRules(pool) });
});

referenceRouter.get('/reason-codes/:network/:code', async (req, res) => {
  const rc = await reference.findReasonCode(pool, req.params.network.toUpperCase(), req.params.code);
  res.json({ data: rc });
});
