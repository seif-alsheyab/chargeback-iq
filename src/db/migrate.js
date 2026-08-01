// Migration runner.
//
// Applies every .sql file in migrations/ exactly once, in filename order.
// Each file runs inside a transaction: if any statement in it fails, the
// whole file rolls back and the migration is not recorded as applied.
//
// A sha256 checksum of each file is stored. If an already-applied file is
// later edited, the runner refuses to continue -- because the database no
// longer matches the file, and silently ignoring that causes environments
// to drift apart.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations'
);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function run() {
  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query(
    'SELECT filename, checksum FROM schema_migrations'
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  let count = 0;

  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha256(sql);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied.\n` +
          `Create a new migration instead of editing an applied one.`
        );
      }
      console.log(`  skip   ${file}`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum]
      );
      await client.query('COMMIT');
      console.log(`  apply  ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? 'Database already up to date.' : `Applied ${count} migration(s).`);
}

run()
  .catch((err) => {
    console.error('\nMIGRATION FAILED\n' + err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
