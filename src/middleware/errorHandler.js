// Central error handling.
//
// Express 5 forwards a rejected promise from an async handler here
// automatically, so routes need no try/catch. Express identifies an error
// handler by its FOUR arguments -- drop `next` and it silently becomes an
// ordinary middleware that never runs.

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}` },
  });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    logger.warn('request rejected', {
      code: err.code, status: err.status, path: req.path, method: req.method,
    });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Anything reaching here is unexpected. Log the detail for us; return a
  // generic message to the caller. Internal messages can leak table names,
  // file paths and query fragments that help an attacker map the system.
  logger.error('unhandled error', {
    message: err.message, stack: err.stack, path: req.path, method: req.method,
  });
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
}
