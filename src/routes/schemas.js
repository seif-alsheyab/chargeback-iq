// Zod schemas: the contract for every request the API accepts.
import { z } from 'zod';

export const uuidParam = z.object({ id: z.string().uuid() });

export const openDisputeSchema = z.object({
  caseNumber: z.string().min(1).max(100),
  transactionId: z.string().uuid(),
  reasonCode: z.string().min(1).max(20),
  // Money as an integer in minor units. A float here would eventually
  // produce a case worth 12499.999999 fils.
  disputedAmountMinor: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  disputeFeeMinor: z.number().int().nonnegative().optional(),
  rootCause: z.enum(['ACTUAL_FRAUD', 'MERCHANT_ERROR', 'FRIENDLY_FRAUD', 'UNDETERMINED']).optional(),
  cycle: z.number().int().min(1).max(3).optional(),
  receivedAt: z.coerce.date().optional(),
});

export const changeStatusSchema = z.object({
  toStatus: z.string().min(1).max(50),
  // OPERATOR only. SYSTEM transitions belong to the scheduled sweep, and
  // PROCESSOR_EVENT transitions arrive through the webhook route -- letting
  // a caller name either one would let them forge the audit trail.
  actorId: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
});

export const addEvidenceSchema = z.object({
  kindCode: z.string().min(1).max(50),
  description: z.string().max(2000).optional(),
  fileRef: z.string().max(500).optional(),
  collectedBy: z.string().uuid().optional(),
});

export const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const complianceQuerySchema = z.object({
  merchantId: z.string().uuid(),
  // Accepts 2026-05 or 2026-05-01; normalised to the first of the month UTC.
  periodMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).transform((v) => {
    const [year, month] = v.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1));
  }),
});
