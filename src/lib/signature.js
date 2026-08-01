// Webhook signature verification.
//
// A webhook endpoint is a public URL. Anyone can POST to it. Without a
// signature, an attacker could invent chargebacks, close real ones, or
// forge the audit trail -- so every delivery must prove it came from the
// processor that shares our secret.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compare two strings without leaking timing information.
 *
 * A normal === on secrets is exploitable: it returns as soon as two bytes
 * differ, so a wrong guess that shares the first byte takes measurably
 * longer than one that differs immediately. Repeat that a few thousand
 * times and an attacker recovers the signature byte by byte.
 * timingSafeEqual always compares every byte.
 */
export function safeCompare(a, b) {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  // Length differences leak too, so bail on length before comparing --
  // but only after both buffers exist, and never with an early === .
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Sign the timestamp and body together.
 *
 * Signing only the body would let an attacker capture a valid delivery and
 * replay it forever. Binding the timestamp into the signature means an old
 * capture can be rejected by age without breaking the signature check.
 */
export function computeSignature({ secret, timestamp, rawBody }) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export function verifySignature({ secret, timestamp, rawBody, signature, toleranceSeconds = 300, now = Date.now() }) {
  if (!timestamp || !signature) {
    return { valid: false, reason: 'MISSING_SIGNATURE_HEADERS' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'MALFORMED_TIMESTAMP' };
  }

  // Replay window. Math.abs covers clock skew in both directions -- a sender
  // whose clock runs fast is not an attacker.
  const ageSeconds = Math.abs(now / 1000 - ts);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE', ageSeconds };
  }

  const expected = computeSignature({ secret, timestamp, rawBody });
  if (!safeCompare(expected, signature)) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH' };
  }

  return { valid: true };
}
