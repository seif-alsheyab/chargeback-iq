// Monthly volume figures, needed to compute monitoring-programme ratios.

/** Normalise any date to the first of its month, matching period_month. */
export function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function previousMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
}

export function nextMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export async function upsertMonthlyVolume(db, v) {
  const { rows } = await db.query(
    `INSERT INTO monthly_volumes
       (merchant_id, network_code, period_month, transaction_count,
        card_absent_count, fraud_report_count)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (merchant_id, network_code, period_month) DO UPDATE
        SET transaction_count  = EXCLUDED.transaction_count,
            card_absent_count  = EXCLUDED.card_absent_count,
            fraud_report_count = EXCLUDED.fraud_report_count
     RETURNING *`,
    [
      v.merchantId, v.networkCode, v.periodMonth,
      v.transactionCount ?? 0, v.cardAbsentCount ?? 0, v.fraudReportCount ?? 0,
    ]
  );
  return rows[0];
}

export async function findMonthlyVolume(db, { merchantId, networkCode, periodMonth }) {
  const { rows } = await db.query(
    `SELECT * FROM monthly_volumes
      WHERE merchant_id = $1 AND network_code = $2 AND period_month = $3`,
    [merchantId, networkCode, periodMonth]
  );
  return rows[0] ?? null;
}

/**
 * How many disputes landed for this merchant, on this network, in this month.
 *
 * Counted by received_at, because the networks count a chargeback in the
 * month it was FILED, not the month the original sale happened.
 *
 * The range is half-open: received_at >= start AND < next month. Two reasons
 * that beats date_trunc(received_at):
 *
 *   1. Correctness. date_trunc(col AT TIME ZONE 'UTC') yields a plain
 *      timestamp, while the driver sends a JS Date as timestamptz. Comparing
 *      the two makes Postgres convert via the server timezone, and the match
 *      silently fails -- returning 0 rows with no error at all.
 *   2. Speed. Wrapping a column in a function stops any index on that column
 *      being usable. A plain range comparison can use one.
 */
export async function countDisputesInMonth(db, { merchantId, networkCode, periodMonth }) {
  const rangeEnd = nextMonthStart(periodMonth);
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
       FROM disputes d
       JOIN transactions t ON t.id = d.transaction_id
      WHERE t.merchant_id = $1
        AND d.network_code = $2
        AND d.received_at >= $3
        AND d.received_at <  $4`,
    [merchantId, networkCode, periodMonth, rangeEnd]
  );
  return rows[0].count;
}
