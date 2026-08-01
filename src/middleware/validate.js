// Request validation at the edge.
//
// Anything arriving over HTTP is untrusted: wrong types, missing fields,
// extra fields, hostile values. Validating here means every layer beneath
// can assume its input is already the right shape.

import { ValidationError } from '../lib/errors.js';

export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      // Replace the parsed value with the validated one, so unknown fields
      // are stripped rather than passed along.
      return next(new ValidationError('Request body failed validation.', result.error.issues));
    }
    req.body = result.data;
    return next();
  };
}

export function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new ValidationError('Query parameters failed validation.', result.error.issues));
    }
    req.validatedQuery = result.data;
    return next();
  };
}

export function validateParams(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(new ValidationError('Path parameters failed validation.', result.error.issues));
    }
    req.validatedParams = result.data;
    return next();
  };
}
