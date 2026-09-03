import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const REPO_ROOT = new URL('../../../../', import.meta.url);
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** The developer's DATABASE_URL, used only to reach the server. */
function baseUrl(): URL {
  const envPath = fileURLToPath(new URL('.env', REPO_ROOT));
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (line === undefined) {
    throw new Error('DATABASE_URL is missing from .env — copy .env.example and fill it in.');
  }
  return new URL(line.slice('DATABASE_URL='.length).trim());
}

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = baseUrl();
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export interface TestDatabase {
  /** Connected as the database owner. Bypasses RLS — use only to seed and to prove data exists. */
  readonly owner: Pool;
  /**
   * Connected as a non-owning, non-superuser role with no BYPASSRLS, exactly as the API will
   * be. Every isolation assertion must go through this.
   */
  readonly appUser: Pool;
  readonly appUserRole: string;
  /** Run a query with `app.person_id` set, the way the API sets it per request. */
  asPerson<T>(personId: string, work: (client: PoolClient) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

/**
 * Build a throwaway database from the plain SQL migrations, then hand back two connections:
 * the owner, and a deliberately unprivileged role.
 *
 * The role is the point of this whole harness. A table owner bypasses its own RLS policies, so
 * an isolation test run as owner proves nothing — see the footguns in docs/schema.sql.
 */
export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const role = `${name}_app`;
  const password = randomUUID();

  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    // Dropping the database first releases any grants that would pin the role.
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } finally {
    await admin.end();
  }

  const owner = new Pool({ connectionString: urlFor(name) });

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await owner.query(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
  }

  // Exactly the grants docs/schema.sql documents, plus sequence usage, which inserts need
  // because row_version defaults to nextval(). Note: no DELETE, deliberately.
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  // Removing someone from a roster, and nothing else. Matches scripts/setup-dev-db.sh.
  await owner.query(`GRANT DELETE ON event_players, event_roles TO ${role}`);

  const appUser = new Pool({ connectionString: urlFor(name, { name: role, password }) });

  return {
    owner,
    appUser,
    appUserRole: role,
    async asPerson(personId, work) {
      const client = await appUser.connect();
      try {
        // false = session scope, matching the API's per-request SET.
        await client.query('SELECT set_config($1, $2, false)', ['app.person_id', personId]);
        return await work(client);
      } finally {
        await client.query('SELECT set_config($1, $2, false)', ['app.person_id', '']);
        client.release();
      }
    },
    async destroy() {
      await appUser.end();
      await owner.end();
      const cleanup = new Pool({ connectionString: urlFor('postgres') });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Seed data: two organizations that must never see each other.
// ---------------------------------------------------------------------------

export const ORG_A = '11111111-1111-1111-1111-111111111111';
export const ORG_B = '22222222-2222-2222-2222-222222222222';
export const INSIDER = 'aaaaaaaa-0000-0000-0000-000000000001';
export const OUTSIDER = 'bbbbbbbb-0000-0000-0000-000000000002';
/** On org A's roster but NOT an org member — the case that would blank a leaderboard. */
export const GUEST = 'cccc0000-0000-0000-0000-000000000003';
export const EVENT_A = 'eeeeeeee-0000-0000-0000-000000000001';
export const EVENT_B = 'eeeeeeee-0000-0000-0000-000000000002';
export const PLAYER_A = 'ffffffff-0000-0000-0000-000000000001';
export const PLAYER_GUEST = 'ffffffff-0000-0000-0000-000000000002';
export const RULESET_A = 'dddddddd-0000-0000-0000-000000000001';
export const TEAM_A = 'cccccccc-0000-0000-0000-00000000000a';
export const TEAM_B = 'cccccccc-0000-0000-0000-00000000000b';
export const ROUND_A = '4444aaaa-0000-0000-0000-000000000001';

/** Mirrors docs/schema-tests.sql, extended so every org-scoped table holds an org A row. */
export async function seed(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1,'Divot Diggers','ddd'), ($2,'Other Group','other')`,
    [ORG_A, ORG_B],
  );
  await owner.query(
    `INSERT INTO people (id, display_name, email)
     VALUES ($1,'Justin','j@x.com'), ($2,'Outsider','o@y.com'), ($3,'Guest Golfer','g@z.com')`,
    [INSIDER, OUTSIDER, GUEST],
  );
  await owner.query(
    `INSERT INTO org_members (org_id, person_id, role) VALUES ($1,$2,'owner'), ($3,$4,'owner')`,
    [ORG_A, INSIDER, ORG_B, OUTSIDER],
  );
  await owner.query(
    `INSERT INTO rulesets (id, org_id, key, name, version, document, published_at)
     VALUES ($1,$2,'ddd','DDD',1,'{"a":1}', now())`,
    [RULESET_A, ORG_A],
  );
  // A system preset: org_id NULL, readable by everyone.
  await owner.query(
    `INSERT INTO rulesets (org_id, key, name, version, document, published_at)
     VALUES (NULL,'stableford','Standard Stableford',1,'{"b":1}', now())`,
  );
  await owner.query(
    `INSERT INTO events (id, org_id, name, year, status) VALUES ($1,$2,'DDD 2026',2026,'draft')`,
    [EVENT_A, ORG_A],
  );
  await owner.query(
    `INSERT INTO events (id, org_id, name, year, status) VALUES ($1,$2,'Other 2026',2026,'draft')`,
    [EVENT_B, ORG_B],
  );
  await owner.query(
    `INSERT INTO event_roles (event_id, person_id, role) VALUES ($1,$2,'planner'), ($1,$2,'player')`,
    [EVENT_A, INSIDER],
  );
  await owner.query(
    `INSERT INTO event_players (id, event_id, person_id, starting_ptp, starting_ptp_source)
     VALUES ($1,$2,$3,46,'carried')`,
    [PLAYER_A, EVENT_A, INSIDER],
  );
  // A guest on the roster with no org membership.
  await owner.query(
    `INSERT INTO event_players (id, event_id, person_id, starting_ptp, starting_ptp_source)
     VALUES ($1,$2,$3,30,'seeded_from_handicap')`,
    [PLAYER_GUEST, EVENT_A, GUEST],
  );
  await owner.query(
    `INSERT INTO player_ratings (org_id, person_id, competition_key, raw_value, rounded_value, reason)
     VALUES ($1,$2,'dogfight',14.375,14,'event_carryover')`,
    [ORG_A, INSIDER],
  );
  await owner.query(
    `INSERT INTO rounds (id, event_id, key, name, sequence) VALUES ($1,$2,'thu-am','Thursday AM',1)`,
    [ROUND_A, EVENT_A],
  );
  await owner.query(
    `INSERT INTO cup_teams (id, event_id, key, name) VALUES ($1,$2,'a','Inglorious Bogies'), ($3,$2,'b','Bad Birdies')`,
    [TEAM_A, EVENT_A, TEAM_B],
  );
  await owner.query(
    `INSERT INTO cup_team_members (cup_team_id, event_player_id) VALUES ($1,$2)`,
    [TEAM_A, PLAYER_A],
  );
  await owner.query(
    `INSERT INTO scorecards (round_id, event_player_id) VALUES ($1,$2)`,
    [ROUND_A, PLAYER_A],
  );
  await owner.query(
    `INSERT INTO dogfight_results (round_id, event_player_id, target) VALUES ($1,$2,46)`,
    [ROUND_A, PLAYER_A],
  );
  await owner.query(
    `INSERT INTO sync_mutations (client_uuid, org_id, person_id, event_id, entity_type, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, 'hole_score', '{}')`,
    [ORG_A, INSIDER, EVENT_A],
  );
}
