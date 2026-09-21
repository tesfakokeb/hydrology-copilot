/**
 * Apply the SQL migrations in database/migrations in filename order.
 *
 *   npm run db:migrate
 *
 * Migrations are tracked in hydro.schema_migrations, so re-running is safe.
 * Each file runs in its own transaction: a failure leaves the database at the
 * last successfully applied migration rather than half-way through one.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR ?? join(here, '../../../../database/migrations'));

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'The platform runs without a database on its in-memory synthetic store; migrations are only needed when you want persistence.\n' +
        'Example: DATABASE_URL=postgres://hydro:hydro@localhost:5432/hydro npm run db:migrate',
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS hydro');
    await client.query(`
      CREATE TABLE IF NOT EXISTS hydro.schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum    TEXT
      )
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM hydro.schema_migrations')).rows.map((r) => r.filename),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0) {
      console.error(`No .sql files found in ${MIGRATIONS_DIR}`);
      process.exit(1);
    }

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`· ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`→ ${file} … `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO hydro.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('applied');
        ran += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n${file} failed and was rolled back:\n${(err as Error).message}\n`);
        process.exit(1);
      }
    }

    console.log(`\n${ran} migration${ran === 1 ? '' : 's'} applied, ${files.length - ran} already present.`);
  } finally {
    await client.end();
  }
}

void main();
