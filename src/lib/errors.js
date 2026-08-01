// Typed errors.
//
// Throwing a plain Error loses information: the caller cannot tell a bad
// request apart from a genuine bug. Each class below carries an HTTP status
// and a stable machine-readable code, so the API layer can translate a
// domain failure into the right response without inspecting message strings.

export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

// The requested status change is not in the state machine.
export class InvalidTransitionError extends AppError {
  constructor(from, to, triggeredBy) {
    super(`Cannot move a dispute from ${from} to ${to} when triggered by ${triggeredBy}.`, {
      status: 409,
      code: 'INVALID_TRANSITION',
      details: { from, to, triggeredBy },
    });
  }
}

// The transition exists but the case has no evidence attached.
export class EvidenceRequiredError extends AppError {
  constructor(from, to) {
    super(`Moving from ${from} to ${to} requires at least one evidence item.`, {
      status: 422,
      code: 'EVIDENCE_REQUIRED',
      details: { from, to },
    });
  }
}
