// Single shared connection pool for the whole app.
//
// Why a pool and not one connection per request: opening a Postgres
// connection is expensive (TCP handshake + auth + backend process spawn).
// A pool keeps a small set of connections open and lends them out, so a
// request borrows one, uses it, and returns it.
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                       // never hold more than 10 connections
  idleTimeoutMillis: 30000,      // release a connection idle for 30s
  connectionTimeoutMillis: 5000, // fail fast if the DB is unreachable
});

// A connection can die while sitting idle in the pool (DB restart, network
// drop). Without this listener that surfaces as an unhandled error event
// and takes the whole Node process down.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// Convenience wrapper so callers write query('SELECT ...', [params])
// instead of reaching into the pool object every time.
export function query(text, params) {
  return pool.query(text, params);
}

export async function closePool() {
  await pool.end();
}
