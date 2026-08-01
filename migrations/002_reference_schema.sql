-- Reference data: the card-network rules the rest of the system depends on.
-- These tables change when the networks change their rules, not when a
-- dispute is worked. Kept separate from operational tables for that reason.

CREATE TABLE card_networks (
  code        TEXT PRIMARY KEY,          -- VISA, MASTERCARD, AMEX, DISCOVER
  name        TEXT NOT NULL,
  -- Which monitoring programme applies. VAMP and ECP compute completely
  -- different ratios, so the calculator is selected off this column.
  monitoring_program TEXT NOT NULL
    CHECK (monitoring_program IN ('VAMP', 'ECP', 'NONE'))
);

-- Our own taxonomy. Every processor's raw reason code maps into exactly one
-- of these, so analytics can group across processors that use different codes
-- for the same underlying problem.
CREATE TABLE dispute_categories (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  -- Fraud-category disputes feed the fraud side of the VAMP numerator.
  counts_as_fraud BOOLEAN NOT NULL DEFAULT false
);

-- Raw network reason codes, mapped to our categories.
CREATE TABLE reason_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_code  TEXT NOT NULL REFERENCES card_networks(code),
  code          TEXT NOT NULL,           -- '10.4', '4837', ...
  title         TEXT NOT NULL,
  category_code TEXT NOT NULL REFERENCES dispute_categories(code),
  -- Visa routes disputes down two different tracks; Mastercard has one.
  -- The track changes who may act and what deadlines apply.
  workflow      TEXT NOT NULL
    CHECK (workflow IN ('ALLOCATION', 'COLLABORATION', 'SINGLE_TRACK')),
  -- Free-text guidance on what evidence tends to win this code.
  evidence_guidance TEXT,
  UNIQUE (network_code, code)
);

-- Deadline rules. Deliberately data, not constants: the network allows 30
-- days, but processors compress it (9 days US/CA, 18 days elsewhere on some
-- acquirers) and it varies by region. Hardcoding guarantees being wrong.
CREATE TABLE deadline_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_code   TEXT NOT NULL REFERENCES card_networks(code),
  stage          TEXT NOT NULL,          -- which status the clock applies to
  region         TEXT NOT NULL DEFAULT 'DEFAULT',
  processor_code TEXT,                   -- NULL = applies to all processors
  response_days  INTEGER NOT NULL CHECK (response_days > 0),
  -- How many days before expiry a case should start warning operators.
  warn_days_before INTEGER NOT NULL DEFAULT 3 CHECK (warn_days_before >= 0),
  notes          TEXT,
  UNIQUE (network_code, stage, region, processor_code)
);

-- The lifecycle states a dispute can occupy.
CREATE TABLE dispute_statuses (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  -- Terminal states end the case; no transition may leave them.
  is_terminal  BOOLEAN NOT NULL DEFAULT false,
  -- Did the merchant keep the money in this state? NULL where undecided.
  is_won       BOOLEAN,
  sort_order   INTEGER NOT NULL
);

-- The state machine itself, stored as data. Every allowed move is a row.
-- Anything not listed here is impossible, and the service layer enforces it.
-- Storing it this way means the rules can be inspected with a SELECT and
-- tested directly, instead of hiding in branching logic.
CREATE TABLE status_transitions (
  from_status   TEXT NOT NULL REFERENCES dispute_statuses(code),
  to_status     TEXT NOT NULL REFERENCES dispute_statuses(code),
  -- Who is allowed to trigger it: an operator, or an inbound processor event.
  triggered_by  TEXT NOT NULL
    CHECK (triggered_by IN ('OPERATOR', 'PROCESSOR_EVENT', 'SYSTEM')),
  -- Some moves are invalid without evidence attached (e.g. representment).
  requires_evidence BOOLEAN NOT NULL DEFAULT false,
  description   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status, triggered_by),
  CHECK (from_status <> to_status)
);

CREATE INDEX idx_reason_codes_category ON reason_codes (category_code);
CREATE INDEX idx_deadline_rules_lookup ON deadline_rules (network_code, stage, region);
