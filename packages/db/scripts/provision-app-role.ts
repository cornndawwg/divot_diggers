// Create the non-owning database role the API connects as, and grant it exactly what it needs.
//
//   pnpm db:provision-role
//
// Run once against a new database, after the migrations. Connects as the owner (DATABASE_URL)
// and creates APP_DATABASE_ROLE with APP_DATABASE_PASSWORD.
//
// This exists because of invariant #5. A Postgres table owner bypasses its own row level
// security, so an API connecting with the owning role has every policy in the schema quietly
// switched off — org A can read org B and nothing anywhere reports a problem. The role made
// here is NOSUPERUSER NOBYPASSRLS and does not own the tables, which is what makes the
// policies actually apply. It is safe to re-run.
import { Pool } from 'pg';

const url = process.env['DATABASE_URL'];
const role = process.env['APP_DATABASE_ROLE'] ?? 'ddga_app';
const password = process.env['APP_DATABASE_PASSWORD'];

if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set. It must be the owning connection.');
  process.exit(1);
}
if (password === undefined || password === '') {
  console.error(
    'APP_DATABASE_PASSWORD is not set. Generate one with: openssl rand -hex 32\n' +
      'Then set APP_DATABASE_URL on the API to the same credentials.',
  );
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error(`APP_DATABASE_ROLE "${role}" is not a plain identifier.`);
  process.exit(1);
}

// Tables the app may delete from. Everything else is append-only or amended in place.
// Two are roster entries, taken off when somebody drops out; two are the cup sides, which a
// planner rearranges; two are tee groups, which are replaced wholesale each time a sheet is
// laid out; the last is the derived results cache, rebuilt from scorecards.
const DELETABLE = [
  'event_players',
  'event_roles',
  'dogfight_results',
  'tee_groups',
  'tee_group_members',
  'cup_teams',
  'cup_team_members',
];

const pool = new Pool({ connectionString: url });
try {
  const owner = await pool.query<{ current_user: string; db: string }>(
    'SELECT current_user, current_database() AS db',
  );
  console.log(`Connected to ${owner.rows[0]?.db} as ${owner.rows[0]?.current_user}.`);

  const existing = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.rowCount === 0) {
    await pool.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password.replace(/'/g, "''")}' ` +
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
    );
    console.log(`  created role ${role}`);
  } else {
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password.replace(/'/g, "''")}' ` +
      'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
    console.log(`  role ${role} already existed — password and attributes reset`);
  }

  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await pool.query(`GRANT DELETE ON ${DELETABLE.join(', ')} TO ${role}`);
  // So a later migration's tables are reachable without re-running this by hand.
  await pool.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${role}`,
  );
  await pool.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${role}`,
  );
  console.log('  granted select/insert/update on every table, delete on seven');

  // The check that matters. If any of these is wrong, RLS is off and tenancy is not enforced.
  const check = await pool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    owns: string;
  }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid)::text AS owns
       FROM pg_roles r WHERE r.rolname = $1`,
    [role],
  );
  const row = check.rows[0];
  const problems: string[] = [];
  if (row?.rolsuper === true) problems.push('it is a superuser');
  if (row?.rolbypassrls === true) problems.push('it has BYPASSRLS');
  if (row !== undefined && row.owns !== '0') problems.push(`it owns ${row.owns} tables`);

  if (problems.length > 0) {
    console.error(
      `\nRefusing to call this done: ${role} would bypass row level security because ` +
        `${problems.join(' and ')}. Every tenancy policy in the schema would be inert.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n${role} is not a superuser, has no BYPASSRLS, and owns no tables.`);
    console.log('Set APP_DATABASE_URL on the API to this role.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
