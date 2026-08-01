// Response deadlines.
//
// The networks publish a baseline (often 30 days) but acquirers compress it
// by region, and some processors compress it further. So the rules live in
// the deadline_rules table and the most specific matching row wins.

import { ValidationError } from '../lib/errors.js';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Choose the rule that applies.
 *
 * Specificity scoring: a rule naming this exact region beats a DEFAULT
 * region rule, and a rule naming this exact processor beats one that
 * applies to all processors. A rule for a different region or a different
 * processor is not a candidate at all.
 */
export function selectDeadlineRule(rules, { networkCode, stage, region, processorCode = null }) {
  let best = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.network_code !== networkCode) continue;
    if (rule.stage !== stage) continue;

    const regionMatches = rule.region === region;
    const regionIsDefault = rule.region === 'DEFAULT';
    if (!regionMatches && !regionIsDefault) continue;

    const processorMatches = rule.processor_code === processorCode;
    const processorIsWildcard = rule.processor_code === null || rule.processor_code === undefined;
    if (!processorMatches && !processorIsWildcard) continue;

    const score = (regionMatches ? 2 : 0) + (processorMatches && !processorIsWildcard ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best;
}

/** Add the response window to the date the dispute arrived. */
export function computeRespondBy(receivedAt, responseDays) {
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
    throw new ValidationError('receivedAt must be a valid Date.');
  }
  if (!Number.isInteger(responseDays) || responseDays <= 0) {
    throw new ValidationError('responseDays must be a positive whole number.');
  }
  return new Date(receivedAt.getTime() + responseDays * MS_PER_DAY);
}

/** Whole days left. Negative once the deadline has passed. */
export function daysRemaining(now, respondBy) {
  return Math.floor((respondBy.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Traffic light for the operator queue.
 *   EXPIRED - the window closed; the case cannot be defended any more
 *   WARNING - inside the warning window; act now
 *   OK      - time remains
 */
export function deadlineState(now, respondBy, warnDaysBefore) {
  if (now.getTime() >= respondBy.getTime()) return 'EXPIRED';
  const warningStarts = respondBy.getTime() - warnDaysBefore * MS_PER_DAY;
  if (now.getTime() >= warningStarts) return 'WARNING';
  return 'OK';
}

/** Sort helper: soonest deadline first, so the queue shows urgency at the top. */
export function byDeadlineAscending(a, b) {
  return a.respond_by.getTime() - b.respond_by.getTime();
}
