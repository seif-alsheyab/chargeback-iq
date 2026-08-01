# chargeback-iq

Dispute and chargeback operations platform. Tracks a card dispute from arrival
to resolution with an enforced lifecycle, per-network response deadlines,
evidence requirements, an immutable audit trail, and monitoring-programme
ratio calculation for Visa and Mastercard.

Built to answer one question a risk team asks every day: **which cases need
attention right now, and are we about to breach a network threshold?**

[![CI](https://github.com/seif-alsheyab/chargeback-iq/actions/workflows/ci.yml/badge.svg)](https://github.com/seif-alsheyab/chargeback-iq/actions/workflows/ci.yml)

---

## Why this exists

A chargeback is a forced reversal: the cardholder's bank pulls funds back out
of the merchant account and tells the merchant afterwards. From that moment a
clock runs. Miss it and the money is gone regardless of how strong the evidence
was.

Most teams track this in a spreadsheet. A spreadsheet cannot stop an analyst
recording a case as "represented" when nothing was submitted, cannot tell a
missed deadline apart from a lost argument, and cannot compute the two network
ratios correctly because **they are not the same formula**.

This system encodes those rules where they cannot be bypassed.

---

## Architecture

HTTP ─────────────────────────────────────────────────────────
routes/ validation (Zod), status codes, security
│
services/ orchestration: what must happen atomically
│
domain/ pure functions: state machine, deadlines, ratios
│
repositories/ SQL only, no business rules
│
PostgreSQL constraints, triggers, the state machine as data
──────────────────────────────────────────────────────────────

Two deliberate choices shape everything:

**Rules live in the database where they can be bypassed by nobody.** The set of
legal status transitions is a table, not a chain of `if` statements. The audit
log rejects `UPDATE` and `DELETE` at trigger level, so a bug — or someone with a
psql prompt — cannot rewrite history. Deadlines and evidence requirements are
rows, because networks change their rules and operations should not need a
deployment to follow.

**Domain functions receive their data, they never fetch it.** `assertTransition`
is handed the transitions list; it does not query for it. That is why 61 unit
tests run in ~40ms with no database involved, and why the same function is
exercised against fake data in unit tests and real tables in integration tests.

---

## The dispute lifecycle

PRE_DISPUTE_ALERT ─┐
INQUIRY ───────────┤
▼
CHARGEBACK_RECEIVED
│ operator picks it up
▼
UNDER_REVIEW
│ │
no evidence│ │evidence required
needed ▼ ▼
ACCEPTED REPRESENTED
│
┌─────────┼─────────┐
▼ ▼ ▼
WON LOST PRE_ARBITRATION
│
ARBITRATION
│ │
WON LOST

SYSTEM only ──▶ EXPIRED (from CHARGEBACK_RECEIVED, UNDER_REVIEW,
PRE_ARBITRATION)

Three rules that are easy to get wrong and are enforced here:

**You cannot skip review.** There is no transition from `CHARGEBACK_RECEIVED`
straight to `REPRESENTED`. Somebody has to decide whether the case is worth
fighting, and that decision is recorded.

**Representment requires evidence; conceding does not.** `REPRESENTED` means an
evidence package was submitted. Allowing that status with nothing attached would
let the database record a fight that never happened — and then nobody could
explain why the "fought" win rate looks so bad.

**`EXPIRED` and `LOST` are separate, and only the system can set `EXPIRED`.**
Financially identical, operationally opposite: `LOST` means the evidence was not
convincing, `EXPIRED` means nobody answered in time. One is fixed with better
evidence, the other with staffing or alerting. Every expiry is preventable, and
it is the only outcome that is entirely the team's own fault. Making it
`SYSTEM`-triggered stops an analyst quietly relabelling "I did not get to it" as
"the clock beat us" — their only manual exit is `ACCEPTED`, which carries their
name.

---

## Monitoring programmes: two networks, two different formulas

This is the part most implementations get wrong by storing a single
"chargeback rate".

**Mastercard ECP** divides this month's chargebacks by **last month's**
transactions, and requires **both** a count and a ratio threshold:

| Tier | Chargeback count | Ratio  |
|------|------------------|--------|
| ECM  | ≥ 100            | ≥ 1.5% |
| HECM | ≥ 300            | ≥ 3.0% |

The one-month lag has a consequence worth stating plainly: **a drop in sales can
put a merchant in breach with no change in chargeback behaviour at all.** 120
chargebacks against 10,000 sales this month reads as a comfortable 1.20% — but
if last month was quiet at 6,000, the real figure is 2.00% and both ECM
conditions are met.

**Visa VAMP** divides `(fraud reports + disputes)` by settled **card-absent**
transactions in the **same** month, with a floor of 1,500 combined events before
a merchant is assessed at all:

| Region  | Merchant excessive threshold |
|---------|------------------------------|
| Default | 1.50% (since 1 April 2026)   |
| CEMEA   | 2.20%                        |

CEMEA covers Jordan and the UAE. Identical activity is compliant there and
excessive in the EU — which is why `region` is a merchant attribute and not a
constant.

Both calculators return a `NOT_ASSESSABLE` tier when the denominator is zero,
rather than reporting 0%. A compliance system that says "you're fine" when it
has no idea is more dangerous than one that says nothing.

---

## Running it

Requires Node ≥ 20 and Docker.

```bash
git clone https://github.com/seif-alsheyab/chargeback-iq.git
cd chargeback-iq
npm install
cp .env.example .env

npm run db:up      # Postgres 16 on localhost:5433
npm run migrate    # apply schema
npm run seed       # realistic demo data
npm start          # API on localhost:4010
```

Then:

```bash
curl -s localhost:4010/api/disputes/queue | jq
curl -s "localhost:4010/api/compliance?merchantId=<id>&periodMonth=2026-08" | jq
```

The seed script prints ready-to-paste URLs with real IDs. It goes through the
service layer rather than raw inserts, so every demo case obeys the same state
machine as production traffic — if a seeded transition were illegal, seeding
would fail.

### Tests

```bash
npm test
```

127 tests. Unit tests run with no database. Integration tests run inside a
transaction that is always rolled back, so the database is byte-identical before
and after. The HTTP suites commit (a supertest request uses its own pool
connection and cannot see uncommitted rows), so each owns a separate cleanup
scope and asserts it left nothing behind.

CI runs the suite **twice**. A suite that only passes on a virgin database is
not a suite you can trust.

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness. Deliberately does not touch the database. |
| `GET`  | `/ready` | Readiness. Does check the database. |
| `POST` | `/api/disputes` | Open a dispute; deadline computed from network + region. |
| `GET`  | `/api/disputes/queue` | Work queue, soonest deadline first, with `OK` / `WARNING` / `EXPIRED`. |
| `GET`  | `/api/disputes/:id` | Full case: events, evidence, and the transitions legal right now. |
| `POST` | `/api/disputes/:id/status` | Operator-triggered transition. |
| `POST` | `/api/disputes/:id/evidence` | Attach evidence. |
| `GET`  | `/api/disputes/:id/evidence-requirements` | What this reason code needs, and what is missing. |
| `GET`  | `/api/compliance` | VAMP and ECP evaluated for a merchant and month. |
| `GET`  | `/api/reference/*` | Statuses, transitions, deadline rules, reason codes. |
| `POST` | `/webhooks/:processor` | Signed PSP webhook ingestion. |

Errors are typed and mapped to meaningful status codes: `400` validation,
`404` not found, `409` illegal transition, `422` evidence required,
`429` rate limited. `INVALID_TRANSITION` and `EVIDENCE_REQUIRED` are distinct
because the fixes are different — one is impossible, the other needs evidence.

`GET /api/disputes/:id` returns `availableActions`, so a client renders exactly
the buttons that will work instead of hardcoding the state machine and drifting
out of sync with it.

---

## Webhooks

A webhook endpoint is a public URL, so three separate protections apply:

**Signature.** HMAC-SHA256 over `timestamp.rawBody`, compared with
`timingSafeEqual`. The route is mounted before the JSON body parser and reads
raw bytes — parsing and re-serialising changes key order and the signature would
never match.

**Replay window.** The timestamp is inside the signed payload, so a captured
delivery older than five minutes is rejected without breaking signature
verification.

**Idempotency.** A unique constraint on `(processor_code, external_event_id)`
with `ON CONFLICT DO NOTHING`. Processors retry aggressively; without this, one
chargeback becomes two disputes and double-counts in the ratios. The database
guarantees it, not the application — checking "does it exist?" then inserting
leaves a window where two concurrent copies both see nothing.

Deliveries with bad signatures are **recorded**, not discarded — refusing to log
them would hide an attack in progress. And a correctly signed delivery still
cannot force an illegal state change: a processor sending `dispute.won` for a
case still in `CHARGEBACK_RECEIVED` gets recorded as `FAILED` and the status is
left alone.

---

## Reason codes

39 codes across Visa and Mastercard, each mapped to an internal category
(`FRAUD`, `AUTHORIZATION`, `PROCESSING_ERROR`, `CONSUMER_DISPUTE`) and carrying
its own evidence requirements.

The raw code and the internal category are stored separately. Visa `10.4` and
Mastercard `4837` are the same underlying problem with different labels —
analytics need the grouping, filing a representment needs the exact code.

Root cause is tracked as a **third, independent** axis: `ACTUAL_FRAUD`,
`MERCHANT_ERROR`, `FRIENDLY_FRAUD`, `UNDETERMINED`. The same reason code can be
any of the three, and the remedy differs completely — actual fraud means fixing
prevention, merchant error means fixing fulfilment, friendly fraud means
fighting with compelling evidence. A system storing only the reason code cannot
tell a manager which of the three is bleeding money.

---

## Schema notes

- **Money is `BIGINT` in minor units.** Floating point cannot represent 0.1
  exactly; a currency column typed `FLOAT` eventually produces a case worth
  12499.999999 fils.
- **UUID primary keys.** Dispute IDs appear in URLs and are shared with
  processors; sequential integers would leak total case volume.
- **`dispute_events.seq` is a `BIGSERIAL`, and ordering uses it.** `now()` in
  Postgres returns the *transaction* start time, so events written in one
  transaction share an identical `occurred_at`. An audit log that cannot say
  which event came first is not an audit log.
- **Month filtering uses a half-open range**, not `date_trunc(column)`. Wrapping
  a column in a function both prevents index use and — because
  `date_trunc(col AT TIME ZONE 'UTC')` yields `timestamp` while the driver sends
  `timestamptz` — silently returns zero rows on a non-UTC server. That direction
  of failure reports a breaching merchant as compliant.
- **`FOR UPDATE` plus an expected-status `WHERE` clause** on status changes, so
  two operators acting simultaneously cannot both "succeed".

---

## Not included

Stated plainly, because a list of what was not built is what makes the rest
credible:

- **No authentication or authorisation.** Operators are rows, not sessions.
  There is no login, no RBAC enforcement, no API keys. Production deployment
  would need this first.
- **No frontend.** API only.
- **No file storage for evidence.** `evidence_items.file_ref` holds a reference;
  uploading and storing the actual documents is not implemented.
- **No real processor integrations.** The webhook receiver is generic and
  signature-verified; it has not been tested against live Stripe or
  Checkout.com payloads, which differ in shape.
- **No scheduler.** `expireOverdueDisputes` exists and is tested, but nothing
  runs it on a timer — that would be a cron job or a queue worker.
- **Reference data is a snapshot.** Reason codes, thresholds and deadlines were
  current when seeded. Networks change these; treat the tables as something
  operations reviews, not permanent truth.

---

## Stack

Node.js 20+ · Express 5 · PostgreSQL 16 · raw SQL via `pg` (no ORM — the SQL is
the point) · Zod · Vitest + Supertest · Docker Compose · GitHub Actions

## Licence

MIT
