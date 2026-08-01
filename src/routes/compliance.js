// Monitoring-programme endpoints.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { validateQuery } from '../middleware/validate.js';
import { complianceQuerySchema } from './schemas.js';
import * as compliance from '../services/complianceService.js';

export const complianceRouter = Router();

complianceRouter.get('/', validateQuery(complianceQuerySchema), async (req, res) => {
  const { merchantId, periodMonth } = req.validatedQuery;
  const report = await compliance.evaluateAllProgrammes(pool, { merchantId, periodMonth });
  res.json({ data: report });
});
