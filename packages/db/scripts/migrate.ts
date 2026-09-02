// Applies the plain SQL migrations to the database in DATABASE_URL.
//
//   pnpm db:migrate
//
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate.ts';

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const pool = new Pool({ connectionString });

try {
  const { applied, skipped } = await runMigrations(pool, migrationsDir);
  for (const file of skipped) console.log(`  already applied  ${file}`);
  for (const file of applied) console.log(`  applied          ${file}`);
  console.log(
    applied.length === 0
      ? 'Database is up to date.'
      : `Applied ${applied.length} migration${applied.length === 1 ? '' : 's'}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await pool.end();
}
