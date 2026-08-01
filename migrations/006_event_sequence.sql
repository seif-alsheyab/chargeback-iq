-- Events need a dependable order.
--
-- now() in Postgres returns the TRANSACTION start time, not the current
-- instant. Two events written inside one transaction therefore share an
-- identical occurred_at, and ordering by it falls through to a random UUID.
-- An audit log that cannot say which event came first is not an audit log.
--
-- A sequence increments on every insert and never ties, so it gives a strict
-- insertion order. occurred_at stays for "roughly when", seq answers "in what
-- order".
ALTER TABLE dispute_events ADD COLUMN seq BIGSERIAL;

CREATE INDEX idx_events_dispute_seq ON dispute_events (dispute_id, seq);
