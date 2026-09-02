import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Open a connection pool.
 *
 * The API must connect as a NON-OWNING role. A table owner bypasses its own RLS
 * policies, which would make every policy in migration 0002 decorative — see the
 * footguns documented in docs/schema.sql.
 */
export function createDatabase(connectionString: string, config: PoolConfig = {}): {
  db: Database;
  pool: Pool;
} {
  const pool = new Pool({ connectionString, ...config });
  return { db: drizzle(pool, { schema }), pool };
}
