// Reads about the original payment.

/**
 * Everything needed to open a dispute against a transaction: the merchant's
 * region (which picks the deadline rule) and the processor (which may
 * compress that deadline further).
 */
export async function findTransactionContext(db, transactionId) {
  const { rows } = await db.query(
    `SELECT t.id, t.merchant_id, t.processor_code, t.network_code,
            t.amount_minor, t.currency, t.is_card_present,
            t.avs_result_code, t.cvv_matched, t.three_ds_authenticated,
            m.region AS merchant_region, m.mid
       FROM transactions t
       JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1`,
    [transactionId]
  );
  return rows[0] ?? null;
}

export async function findTransactionByProcessorId(db, processorCode, processorTransactionId) {
  const { rows } = await db.query(
    `SELECT id FROM transactions
      WHERE processor_code = $1 AND processor_transaction_id = $2`,
    [processorCode, processorTransactionId]
  );
  return rows[0] ?? null;
}
