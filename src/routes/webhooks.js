// Webhook endpoint.
//
// express.raw, not express.json: the signature covers the EXACT bytes the
// processor sent. Parsing to an object and re-serialising changes key order
// and whitespace, so the recomputed signature would never match.

import { Router } from 'express';
import express from 'express';
import { pool } from '../db/pool.js';
import { verifySignature } from '../lib/signature.js';
import { processDelivery } from '../services/webhookService.js';
import { ValidationError } from '../lib/errors.js';

export const webhookRouter = Router();

webhookRouter.post('/:processor',
  express.raw({ type: '*/*', limit: '512kb' }),
  async (req, res) => {
    const processorCode = req.params.processor.toUpperCase();
    const rawBody = req.body.toString('utf8');

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('Webhook body is not valid JSON.');
    }

    const check = verifySignature({
      secret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
      timestamp: req.get('x-webhook-timestamp'),
      rawBody,
      signature: req.get('x-webhook-signature'),
    });

    const externalEventId = payload.id ?? req.get('x-webhook-id');
    if (!externalEventId) {
      throw new ValidationError('Webhook is missing an event id.');
    }

    const result = await processDelivery(pool, {
      processorCode,
      externalEventId,
      eventType: payload.type ?? 'unknown',
      payload,
      signatureValid: check.valid,
    });

    // 401 for a bad signature. Everything else returns 200 even on failure:
    // a non-2xx makes the processor retry, and retrying a delivery whose
    // payload is simply wrong just repeats the same failure forever.
    if (result.outcome === 'REJECTED') {
      return res.status(401).json({
        error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed.' },
      });
    }

    return res.status(200).json({
      data: { outcome: result.outcome, deliveryId: result.delivery?.id ?? null },
    });
  });
