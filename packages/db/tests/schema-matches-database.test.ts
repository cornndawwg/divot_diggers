import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema/index';

/**
 * Holds the Drizzle schema accountable to the real database.
 *
 * The SQL migrations are the source of truth. This asserts the TypeScript agrees
 * with them column for column, so a migration that adds or renames a column
 * without a matching change here fails here rather than at runtime.
 */

const ROOT = new URL('../../../', import.meta.url);

function databaseUrl(): string {
  const envPath = fileURLToPath(new URL('.env', ROOT));
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (line === undefined) throw new Error('DATABASE_URL missing from .env');
  const base = line.slice('DATABASE_URL='.length).trim();
  // Always run against the throwaway migrated database, never the dev one.
  return `${base.slice(0, base.lastIndexOf('/'))}/ddga_schema_types`;
}

function adminUrl(): string {
  const url = databaseUrl();
  return `${url.slice(0, url.lastIndexOf('/'))}/postgres`;
}

// Object.values also yields the row_version sequence, so filter with Drizzle's own
// entity check rather than duck typing.
const drizzleTables: PgTable[] = (Object.values(schema) as unknown[]).filter(
  (value): value is PgTable => is(value, PgTable),
);

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query('DROP DATABASE IF EXISTS ddga_schema_types WITH (FORCE)');
  await admin.query('CREATE DATABASE ddga_schema_types');
  await admin.end();

  pool = new Pool({ connectionString: databaseUrl() });
  const migrationsDir = fileURLToPath(new URL('migrations', new URL('../', import.meta.url)));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

describe('the Drizzle schema and the database', () => {
  it('defines all 28 tables', () => {
    expect(drizzleTables).toHaveLength(28);
  });

  it('names the same tables the database has', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
    );
    const inDatabase = rows.map((row) => row.tablename);
    const inDrizzle = drizzleTables.map((table) => getTableConfig(table).name).sort();
    expect(inDrizzle).toEqual(inDatabase);
  });

  it('agrees on every column, its type and its nullability', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
      ORDER BY table_name, column_name
    `);

    const database = rows.map((row) => ({
      table: row.table_name,
      column: row.column_name,
      notNull: row.is_nullable === 'NO',
    }));

    const drizzle = drizzleTables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map((column) => ({
          table: config.name,
          column: column.name,
          notNull: column.notNull,
        }));
      })
      .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

    expect(drizzle).toEqual(database);
  });

  it('maps email as citext, so addresses are case-insensitive', async () => {
    const { rows } = await pool.query<{ data_type: string; udt_name: string }>(
      "SELECT data_type, udt_name FROM information_schema.columns WHERE table_name = 'people' AND column_name = 'email'",
    );
    expect(rows[0]?.udt_name).toBe('citext');
  });
});

describe('the guarantees the migrations carry', () => {
  it('leaves no table with RLS on but no policy', async () => {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    `);
    expect(rows[0]?.count).toBe('0');
  });

  it('carries 23 policies: 21 from the baseline plus 2 added for people', async () => {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'",
    );
    expect(rows[0]?.count).toBe('23');
  });

  it('protects people, which the baseline schema did not', async () => {
    const { rows } = await pool.query<{ polname: string }>(
      "SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = 'people' ORDER BY polname",
    );
    expect(rows.map((row) => row.polname)).toEqual(['person_read', 'person_update_self']);
  });

  it('carries a row_version trigger on every syncable table', async () => {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE '%_row_version'
    `);
    expect(rows[0]?.count).toBe('19');
  });
});
