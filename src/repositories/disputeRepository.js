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
 * Apply a status change.
 *
 * Note the WHERE clause carries the expected current status. If another
 * process changed the dispute a moment ago, zero rows update and the caller
 * learns the case moved underneath it. Without that guard, two operators
 * clicking at the same time would both "succeed" and the last write would
 * silently win.
 */
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

export async function listEvents(db, disputeId) {
  const { rows } = await db.query(
    `SELECT * FROM dispute_events WHERE dispute_id = $1 ORDER BY occurred_at, id`,
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
