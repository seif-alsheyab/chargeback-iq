// Reads and writes for disputes, evidence, and the event log.

export async function insertDispute(db, d) {
  const { rows } = await db.query(
    `INSERT INTO disputes
       (case_number, transaction_id, network_code, reason_code_id, status_code,
        root_cause, cycle, disputed_amount_minor, currency, dispute_fee_minor,
        received_at, respond_by, assigned_to, provisional_credit_to_cardholder_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      d.caseNumber, d.transactionId, d.networkCode, d.reasonCodeId,
      d.statusCode ?? 'CHARGEBACK_RECEIVED', d.rootCause ?? 'UNDETERMINED',
      d.cycle ?? 1, d.disputedAmountMinor, d.currency, d.disputeFeeMinor ?? 0,
      d.receivedAt, d.respondBy, d.assignedTo ?? null,
      d.provisionalCreditToCardholderAt ?? null,
    ]
  );
  return rows[0];
}

export async function findDisputeById(db, id) {
  const { rows } = await db.query(
    `SELECT d.*, rc.code AS reason_code, rc.title AS reason_title,
            rc.workflow, rc.category_code, s.is_terminal, s.is_won
       FROM disputes d
       JOIN reason_codes rc ON rc.id = d.reason_code_id
       JOIN dispute_statuses s ON s.code = d.status_code
      WHERE d.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findDisputeByCaseNumber(db, caseNumber) {
  const { rows } = await db.query(
    `SELECT * FROM disputes WHERE case_number = $1`,
    [caseNumber]
  );
  return rows[0] ?? null;
}

/**
 * Read a dispute and hold a lock on the row until the transaction ends.
 *
 * FOR UPDATE makes any other transaction wanting the same row wait. Without
 * it, two operators clicking at the same moment could both read status
 * UNDER_REVIEW, both decide their move is legal, and both write.
 */
export async function lockDisputeForUpdate(db, id) {
  const { rows } = await db.query(
    `SELECT * FROM disputes WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateDisputeStatus(db, { id, expectedStatus, toStatus, closedAt = null }) {
  const { rows } = await db.query(
    `UPDATE disputes
        SET status_code = $3,
            closed_at   = COALESCE($4, closed_at),
            updated_at  = now()
      WHERE id = $1 AND status_code = $2
      RETURNING *`,
    [id, expectedStatus, toStatus, closedAt]
  );
  return rows[0] ?? null;
}

export async function setRootCause(db, { id, rootCause }) {
  const { rows } = await db.query(
    `UPDATE disputes SET root_cause = $2, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, rootCause]
  );
  return rows[0] ?? null;
}

export async function appendEvent(db, e) {
  const { rows } = await db.query(
    `INSERT INTO dispute_events
       (dispute_id, event_type, from_status, to_status, actor_type, actor_id, note, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      e.disputeId, e.eventType, e.fromStatus ?? null, e.toStatus ?? null,
      e.actorType, e.actorId ?? null, e.note ?? null,
      JSON.stringify(e.payload ?? {}),
    ]
  );
  return rows[0];
}

/**
 * Event history in true insertion order.
 *
 * Ordered by seq, not occurred_at: events written inside one transaction all
 * carry the same occurred_at, because now() is the transaction start time.
 * seq is a counter that never ties.
 */
export async function listEvents(db, disputeId) {
  const { rows } = await db.query(
    `SELECT * FROM dispute_events WHERE dispute_id = $1 ORDER BY seq`,
    [disputeId]
  );
  return rows;
}

export async function countEvidence(db, disputeId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count FROM evidence_items WHERE dispute_id = $1`,
    [disputeId]
  );
  return rows[0].count;
}

export async function insertEvidence(db, ev) {
  const { rows } = await db.query(
    `INSERT INTO evidence_items (dispute_id, kind_code, description, file_ref, collected_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ev.disputeId, ev.kindCode, ev.description ?? null, ev.fileRef ?? null, ev.collectedBy ?? null]
  );
  return rows[0];
}

export async function listEvidence(db, disputeId) {
  const { rows } = await db.query(
    `SELECT e.*, k.name AS kind_name
       FROM evidence_items e
       JOIN evidence_kinds k ON k.code = e.kind_code
      WHERE e.dispute_id = $1
      ORDER BY e.created_at`,
    [disputeId]
  );
  return rows;
}

/** Open cases, soonest deadline first. This is the operator work queue. */
export async function listOpenDisputesByDeadline(db, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.case_number, d.status_code, d.respond_by, d.assigned_to,
            d.disputed_amount_minor, d.currency, rc.code AS reason_code
       FROM disputes d
       JOIN reason_codes rc ON rc.id = d.reason_code_id
      WHERE d.closed_at IS NULL
      ORDER BY d.respond_by ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Open cases whose response window has already closed. Input to the sweep. */
export async function listOverdueOpenDisputes(db, now) {
  const { rows } = await db.query(
    `SELECT id, status_code, respond_by
       FROM disputes
      WHERE closed_at IS NULL AND respond_by <= $1
      ORDER BY respond_by ASC`,
    [now]
  );
  return rows;
}
