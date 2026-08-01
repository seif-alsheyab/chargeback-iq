// Single shared connection pool for the whole app.
//
// Why a pool and not one connection per request: opening a Postgres
// connection is expensive (TCP handshake + auth + backend process spawn).
// A pool keeps a small set of connections open and lends them out, so a
// request borrows one, uses it, and returns it.
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function closePool() {
  await pool.end();
}
