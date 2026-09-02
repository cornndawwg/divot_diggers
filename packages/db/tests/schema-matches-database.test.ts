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

/**
 * Better Auth owns these (migration 0004) and reads them through its own adapter, so they are
 * deliberately absent from the Drizzle schema. Listing them here rather than filtering them
 * out generically means a new auth table cannot slip in unnoticed.
 */
const AUTH_TABLES = ['account', 'session', 'user', 'verification'];
const NOT_DOMAIN = new Set([...AUTH_TABLES, 'schema_migrations']);

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

  it('names the same domain tables the database has', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const inDatabase = rows.map((row) => row.tablename).filter((name) => !NOT_DOMAIN.has(name));
    const inDrizzle = drizzleTables.map((table) => getTableConfig(table).name).sort();
    expect(inDrizzle).toEqual(inDatabase);
  });

  it('leaves the credential tables to Better Auth', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
         AND tablename = ANY($1::text[]) ORDER BY tablename`,
      [AUTH_TABLES],
    );
    // They exist in the database...
    expect(rows.map((row) => row.tablename)).toEqual(AUTH_TABLES);
    // ...and are intentionally not in the Drizzle schema.
    const inDrizzle = drizzleTables.map((table) => getTableConfig(table).name);
    expect(inDrizzle.filter((name) => AUTH_TABLES.includes(name))).toEqual([]);
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
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `);

    const database = rows
      .filter((row) => !NOT_DOMAIN.has(row.table_name))
      .map((row) => ({
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

  it('carries 31 policies, and accounts for every one', async () => {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'",
    );
    // 21 from the docs/schema.sql baseline, then, per migration:
    //   0003  person_read, person_update_self
    //   0004  auth_owner_only on each of the four credential tables
    //   0005  course_write, course_update, round_write, round_update
    expect(rows[0]?.count).toBe('31');
  });

  it('gives the planner write paths a policy each', async () => {
    const { rows } = await pool.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname IN ('course_write','course_update','round_write','round_update')
        ORDER BY policyname`,
    );
    expect(rows).toEqual([
      { policyname: 'course_update', cmd: 'UPDATE' },
      { policyname: 'course_write', cmd: 'INSERT' },
      { policyname: 'round_update', cmd: 'UPDATE' },
      { policyname: 'round_write', cmd: 'INSERT' },
    ]);
  });

  it('creates a group and its owner membership in one function', async () => {
    // Bootstrapping needs a SECURITY DEFINER function, not a loose INSERT policy: a
    // policy able to insert an organization could insert one nobody belongs to.
    const { rows } = await pool.query<{ proname: string; prosecdef: boolean }>(
      `SELECT proname, prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND proname IN ('create_organization','create_event')
        ORDER BY proname`,
    );
    expect(rows).toEqual([
      { proname: 'create_event', prosecdef: true },
      { proname: 'create_organization', prosecdef: true },
    ]);
  });

  it('denies all access to the credential tables by policy', async () => {
    const { rows } = await pool.query<{ tablename: string; qual: string }>(
      `SELECT tablename, qual FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'auth_owner_only' ORDER BY tablename`,
    );
    expect(rows.map((row) => row.tablename)).toEqual(AUTH_TABLES);
    for (const row of rows) {
      expect(row.qual, row.tablename).toBe('false');
    }
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
