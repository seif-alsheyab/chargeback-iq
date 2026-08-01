// Storage for inbound webhook deliveries.

/**
 * Record a delivery, or report that it was already recorded.
 *
 * ON CONFLICT DO NOTHING makes the insert safe to run concurrently: if two
 * copies of the same delivery arrive at the same instant, exactly one wins
 * and the other gets zero rows back. Checking "does it exist?" first and
 * then inserting would leave a gap between the two queries where both
 * copies see nothing and both insert.
 */
export async function recordDelivery(db, d) {
  const { rows } = await db.query(
    `INSERT INTO webhook_deliveries
       (processor_code, external_event_id, event_type, payload, signature_valid, status)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (processor_code, external_event_id) DO NOTHING
     RETURNING *`,
    [
      d.processorCode, d.externalEventId, d.eventType,
      JSON.stringify(d.payload), d.signatureValid, d.status ?? 'RECEIVED',
    ]
  );
  return rows[0] ?? null;   // null means: already seen
}

export async function findDelivery(db, processorCode, externalEventId) {
  const { rows } = await db.query(
    `SELECT * FROM webhook_deliveries
      WHERE processor_code = $1 AND external_event_id = $2`,
    [processorCode, externalEventId]
  );
  return rows[0] ?? null;
}

export async function markDelivery(db, { id, status, disputeId = null, errorMessage = null }) {
  const { rows } = await db.query(
    `UPDATE webhook_deliveries
        SET status = $2, dispute_id = $3, error_message = $4, processed_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, disputeId, errorMessage]
  );
  return rows[0] ?? null;
}
