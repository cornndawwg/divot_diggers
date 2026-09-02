import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Apply the plain SQL migrations in order.
 *
 * Each file runs inside a transaction and is recorded in `schema_migrations`, so
 * running this twice is safe and a half-applied migration cannot happen. Plain SQL
 * rather than generated DDL is a deliberate choice (see CLAUDE.md's stack table):
 * the migrations must reproduce docs/schema.sql exactly, including RLS policies,
 * triggers and rules that Drizzle cannot express.
 */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const already = new Set(rows.map((row) => row.filename));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    if (already.has(filename)) {
      skipped.push(filename);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      applied.push(filename);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${filename} failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
