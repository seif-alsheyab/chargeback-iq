// The dispute state machine.
//
// The allowed moves live in the status_transitions table. These functions
// take that list as an argument rather than querying for it, which keeps
// them pure: same input, same output, every time. Pure functions are
// trivial to test because there is nothing to set up and nothing to clean.

import { InvalidTransitionError, EvidenceRequiredError } from '../lib/errors.js';

/**
 * Find the transition row matching a requested move.
 * Returns the row, or null when the move is not allowed.
 */
export function findTransition(transitions, { from, to, triggeredBy }) {
  for (const t of transitions) {
    if (t.from_status === from && t.to_status === to && t.triggered_by === triggeredBy) {
      return t;
    }
  }
  return null;
}

/** True when the move is permitted at all. */
export function canTransition(transitions, move) {
  return findTransition(transitions, move) !== null;
}

/** Every status reachable from `from`, with who may trigger each move. */
export function nextStatuses(transitions, from) {
  return transitions
    .filter((t) => t.from_status === from)
    .map((t) => ({
      status: t.to_status,
      triggeredBy: t.triggered_by,
      requiresEvidence: t.requires_evidence,
    }));
}

/** True when no move leaves this status. */
export function isTerminal(transitions, status) {
  return transitions.every((t) => t.from_status !== status);
}

/**
 * Validate a move and return the transition, or throw explaining why not.
 *
 * Two separate failures, deliberately distinguished:
 *   - the move is not in the table at all      -> InvalidTransitionError
 *   - the move is allowed but evidence is absent -> EvidenceRequiredError
 * A caller that sees the second knows the fix is "attach evidence", not
 * "this is impossible". Collapsing both into one error hides that.
 */
export function assertTransition(transitions, { from, to, triggeredBy, evidenceCount = 0 }) {
  const transition = findTransition(transitions, { from, to, triggeredBy });

  if (transition === null) {
    throw new InvalidTransitionError(from, to, triggeredBy);
  }

  if (transition.requires_evidence && evidenceCount < 1) {
    throw new EvidenceRequiredError(from, to);
  }

  return transition;
}
