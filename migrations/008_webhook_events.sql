-- Inbound webhook deliveries.
--
-- Processors retry aggressively: a timeout, a slow response, or a network
-- blip all produce the same delivery again. Without a record of what has
-- already been processed, a retry opens a second dispute for one chargeback
-- -- which then double-counts in the monitoring ratios.
--
-- The unique constraint on (processor_code, external_event_id) is the whole
-- defence. The database, not the application, guarantees each delivery is
-- handled once.

CREATE TABLE webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_code    TEXT NOT NULL REFERENCES processors(code),
  external_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  signature_valid   BOOLEAN NOT NULL,
  status            TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  dispute_id        UUID REFERENCES disputes(id),
  error_message     TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  UNIQUE (processor_code, external_event_id)
);

CREATE INDEX idx_webhook_status ON webhook_deliveries (status, received_at);
