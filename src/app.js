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
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Security headers: disables MIME sniffing, blocks clickjacking, and
  // removes the header that advertises the framework version.
  app.use(helmet());

  // A body limit is a denial-of-service control. Without it a single request
  // can allocate unbounded memory.
  app.use(express.json({ limit: '256kb' }));

  // Writes are limited more tightly than reads: they cost a transaction and
  // a row, whereas a read is cheap.
  const writeLimiter = rateLimit({
    windowMs: 60_000, limit: 60,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many write requests.' } },
  });

  // Liveness probe. Does NOT touch the database -- a health check that
  // queries Postgres will report the app dead during a brief DB blip and
  // trigger a pointless restart.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  });

  // Readiness probe. This one DOES check the database, because a instance
  // that cannot reach Postgres should not receive traffic.
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
