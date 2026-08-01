import { describe, it, expect } from 'vitest';
import { computeSignature, verifySignature, safeCompare } from '../../src/lib/signature.js';

const SECRET = 'test_secret_value';
const NOW = new Date('2026-05-01T12:00:00Z').getTime();
const TS = String(Math.floor(NOW / 1000));
const BODY = '{"id":"evt_1","type":"dispute.created"}';

describe('safeCompare', () => {
  it('matches identical strings', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(safeCompare('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });

  it('handles null and undefined safely', () => {
    expect(safeCompare(null, 'abc')).toBe(false);
    expect(safeCompare(undefined, undefined)).toBe(true);
  });
});

describe('verifySignature', () => {
  const sign = (body = BODY, ts = TS) =>
    computeSignature({ secret: SECRET, timestamp: ts, rawBody: body });

  it('accepts a correctly signed, fresh delivery', () => {
    const result = verifySignature({
      secret: SECRET, timestamp: TS, rawBody: BODY, signature: sign(), now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body even with a real signature', () => {
    const result = verifySignature({
      secret: SECRET, timestamp: TS,
      rawBody: '{"id":"evt_1","type":"dispute.won"}',   // changed after signing
      signature: sign(), now: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects a signature made with the wrong secret', () => {
    const forged = computeSignature({ secret: 'wrong_secret', timestamp: TS, rawBody: BODY });
    const result = verifySignature({
      secret: SECRET, timestamp: TS, rawBody: BODY, signature: forged, now: NOW,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a replay from ten minutes ago', () => {
    const oldTs = String(Math.floor(NOW / 1000) - 600);
    const result = verifySignature({
      secret: SECRET, timestamp: oldTs, rawBody: BODY,
      signature: sign(BODY, oldTs), now: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('TIMESTAMP_OUTSIDE_TOLERANCE');
  });

  it('tolerates modest clock skew in either direction', () => {
    for (const offset of [-120, 120]) {
      const ts = String(Math.floor(NOW / 1000) + offset);
      const result = verifySignature({
        secret: SECRET, timestamp: ts, rawBody: BODY,
        signature: sign(BODY, ts), now: NOW,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('rejects a delivery with no signature headers at all', () => {
    const result = verifySignature({ secret: SECRET, rawBody: BODY, now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('MISSING_SIGNATURE_HEADERS');
  });

  it('rejects a malformed timestamp', () => {
    const result = verifySignature({
      secret: SECRET, timestamp: 'yesterday', rawBody: BODY, signature: sign(), now: NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('MALFORMED_TIMESTAMP');
  });
});
