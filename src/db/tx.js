// Transaction helper.
//
// Some operations must happen together or not at all. Changing a dispute's
// status AND writing the event that records the change is one example: a
// status with no event is a case with a missing history, which defeats the
// point of an audit log.
//
// BEGIN opens the transaction, COMMIT makes everything permanent, ROLLBACK
// undoes all of it. The `finally` block always returns the connection to
// the pool, even when something throws -- forget that and the pool slowly
// runs dry and the app hangs.

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
