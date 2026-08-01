// Express application.
//
// Kept separate from server.js so tests can import the app and drive it with
// supertest without ever opening a network port.

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool } from './db/pool.js';
import { disputeRouter } from './routes/disputes.js';
import { complianceRouter } from './routes/compliance.js';
import { referenceRouter } from './routes/reference.js';
import { webhookRouter } from './routes/webhooks.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.use(helmet());

  // Webhooks are mounted BEFORE express.json, because the signature covers
  // the raw bytes. Once a JSON parser has consumed the stream, the original
  // bytes are gone and the signature can never be recomputed.
  app.use('/webhooks', webhookRouter);

  app.use(express.json({ limit: '256kb' }));

  const writeLimiter = rateLimit({
    windowMs: 60_000, limit: 60,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many write requests.' } },
  });

  // Liveness: deliberately does NOT touch the database, so a brief DB blip
  // does not get the container killed and restarted for no reason.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  });

  // Readiness: this one DOES check the database, because an instance that
  // cannot reach Postgres should not be sent traffic.
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready', database: 'reachable' });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', database: 'unreachable', reason: err.message });
    }
  });

  app.use('/api/disputes', (req, res, next) =>
    (req.method === 'GET' ? next() : writeLimiter(req, res, next)), disputeRouter);
  app.use('/api/compliance', complianceRouter);
  app.use('/api/reference', referenceRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);   // must be registered LAST

  return app;
}
