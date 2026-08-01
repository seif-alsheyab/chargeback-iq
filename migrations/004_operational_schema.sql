-- Operational tables: the things that change every day as cases are worked.

CREATE TABLE operators (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('ANALYST','MANAGER','ADMIN')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_operators_email ON operators (lower(email));

CREATE TABLE processors (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Some processors expose a representment API; others need manual filing.
  supports_api_representment BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE merchants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  mid        TEXT NOT NULL UNIQUE,   -- merchant ID the networks monitor
  -- Region drives which deadline rule applies, and which VAMP threshold.
  region     TEXT NOT NULL DEFAULT 'DEFAULT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Address Verification Service results. Stored as reference data because the
-- match level, not the raw letter, is what matters when scoring evidence.
CREATE TABLE avs_results (
  code        TEXT PRIMARY KEY,
  meaning     TEXT NOT NULL,
  match_level TEXT NOT NULL CHECK (match_level IN ('FULL','PARTIAL','NONE','UNAVAILABLE'))
);

-- The original payment. This is where fraud signals live, and they must be
-- captured at authorisation time: you cannot go back and collect an AVS
-- result months later when the dispute arrives.
CREATE TABLE transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id            UUID NOT NULL REFERENCES merchants(id),
  processor_code         TEXT NOT NULL REFERENCES processors(code),
  network_code           TEXT NOT NULL REFERENCES card_networks(code),
  processor_transaction_id TEXT NOT NULL,
  -- Money is stored in minor units (fils, cents) as an integer. Floating
  -- point cannot represent 0.1 exactly, so currency amounts are never FLOAT.
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  currency               CHAR(3) NOT NULL,
  card_bin               TEXT,
  card_last4             TEXT,
  -- Card-present transactions carry different liability than card-absent.
  is_card_present        BOOLEAN NOT NULL DEFAULT false,
  avs_result_code        TEXT REFERENCES avs_results(code),
  cvv_matched            BOOLEAN,
  three_ds_authenticated BOOLEAN NOT NULL DEFAULT false,
  customer_email         TEXT,
  customer_ip            INET,
  device_fingerprint     TEXT,
  billing_country        CHAR(2),
  shipping_country       CHAR(2),
  occurred_at            TIMESTAMPTZ NOT NULL,
  settled_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (processor_code, processor_transaction_id)
);

CREATE TABLE disputes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number         TEXT NOT NULL UNIQUE,
  transaction_id      UUID NOT NULL REFERENCES transactions(id),
  network_code        TEXT NOT NULL REFERENCES card_networks(code),
  reason_code_id      UUID NOT NULL REFERENCES reason_codes(id),
  status_code         TEXT NOT NULL REFERENCES dispute_statuses(code),

  -- What the bank called it is the reason code. What actually happened is
  -- the root cause, and it drives a completely different remedy:
  --   ACTUAL_FRAUD   -> stolen card. Usually unwinnable; fix prevention.
  --   MERCHANT_ERROR -> our mistake. Fix fulfilment or billing.
  --   FRIENDLY_FRAUD -> real cardholder disputing a real purchase. Fight it.
  root_cause          TEXT NOT NULL DEFAULT 'UNDETERMINED'
    CHECK (root_cause IN ('ACTUAL_FRAUD','MERCHANT_ERROR','FRIENDLY_FRAUD','UNDETERMINED')),

  -- 1 = first chargeback, 2 = second chargeback / pre-arbitration,
  -- 3 = arbitration. Visa permits only one pre-arbitration round;
  -- Mastercard, Discover and Amex permit a second.
  cycle               SMALLINT NOT NULL DEFAULT 1 CHECK (cycle BETWEEN 1 AND 3),

  disputed_amount_minor BIGINT NOT NULL CHECK (disputed_amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  dispute_fee_minor   BIGINT NOT NULL DEFAULT 0 CHECK (dispute_fee_minor >= 0),

  -- Two provisional credits can exist at once: one to the cardholder when
  -- the chargeback is filed, one back to the merchant when evidence is
  -- submitted. Exactly one becomes permanent at resolution.
  provisional_credit_to_cardholder_at TIMESTAMPTZ,
  provisional_credit_to_merchant_at   TIMESTAMPTZ,

  received_at         TIMESTAMPTZ NOT NULL,
  respond_by          TIMESTAMPTZ NOT NULL,
  assigned_to         UUID REFERENCES operators(id),
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (respond_by > received_at)
);

CREATE INDEX idx_disputes_status      ON disputes (status_code);
CREATE INDEX idx_disputes_transaction ON disputes (transaction_id);
CREATE INDEX idx_disputes_assigned    ON disputes (assigned_to) WHERE closed_at IS NULL;
-- Partial index: the deadline queue only ever looks at open cases, so the
-- index only covers those rows. Smaller index, faster queue.
CREATE INDEX idx_disputes_deadline    ON disputes (respond_by) WHERE closed_at IS NULL;

-- Append-only history. Every status change and every processor message lands
-- here. Nothing is ever edited or deleted -- that is what makes it evidence.
CREATE TABLE dispute_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  UUID NOT NULL REFERENCES disputes(id),
  event_type  TEXT NOT NULL,
  from_status TEXT REFERENCES dispute_statuses(code),
  to_status   TEXT REFERENCES dispute_statuses(code),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('OPERATOR','PROCESSOR_EVENT','SYSTEM')),
  actor_id    UUID REFERENCES operators(id),
  note        TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An operator-driven event must record which operator did it.
  CHECK (actor_type <> 'OPERATOR' OR actor_id IS NOT NULL)
);
CREATE INDEX idx_events_dispute ON dispute_events (dispute_id, occurred_at);

-- Enforced immutability. Application code could always be changed; a database
-- trigger cannot be bypassed by a bug or a careless UPDATE in a console.
CREATE FUNCTION reject_event_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'dispute_events is append-only; % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_immutable
  BEFORE UPDATE OR DELETE ON dispute_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE evidence_kinds (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
);

-- Which evidence matters for which reason code. Data, not code, because the
-- networks change their guidance and operations should be able to adjust it.
CREATE TABLE evidence_requirements (
  reason_code_id      UUID NOT NULL REFERENCES reason_codes(id),
  evidence_kind_code  TEXT NOT NULL REFERENCES evidence_kinds(code),
  requirement         TEXT NOT NULL CHECK (requirement IN ('REQUIRED','RECOMMENDED','OPTIONAL')),
  PRIMARY KEY (reason_code_id, evidence_kind_code)
);

CREATE TABLE evidence_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   UUID NOT NULL REFERENCES disputes(id),
  kind_code    TEXT NOT NULL REFERENCES evidence_kinds(code),
  description  TEXT,
  file_ref     TEXT,
  collected_by UUID REFERENCES operators(id),
  submitted_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_dispute ON evidence_items (dispute_id);

-- Monthly volumes, needed because the two networks divide by different things.
-- Mastercard ECP: this month's chargebacks / LAST month's transactions.
-- Visa VAMP: (fraud reports + disputes) / settled card-absent transactions.
-- Neither can be computed without storing volume per month per network.
CREATE TABLE monthly_volumes (
  merchant_id        UUID NOT NULL REFERENCES merchants(id),
  network_code       TEXT NOT NULL REFERENCES card_networks(code),
  period_month       DATE NOT NULL,          -- always the 1st of the month
  transaction_count  INTEGER NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  card_absent_count  INTEGER NOT NULL DEFAULT 0 CHECK (card_absent_count >= 0),
  fraud_report_count INTEGER NOT NULL DEFAULT 0 CHECK (fraud_report_count >= 0),
  PRIMARY KEY (merchant_id, network_code, period_month),
  CHECK (date_trunc('month', period_month) = period_month)
);
