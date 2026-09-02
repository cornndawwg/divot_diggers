import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  seed,
  EVENT_A,
  EVENT_B,
  INSIDER,
  ORG_A,
  OUTSIDER,
  PLAYER_A,
  ROUND_A,
  RULESET_A,
  TEAM_B,
  type TestDatabase,
} from './helpers/test-database';

/**
 * The Vitest port of docs/schema-tests.sql, run as a non-owning role so the policies are
 * actually in force, plus the two guards that file documents but never exercises.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase('ddga_tenancy');
  await seed(database.owner);
}, 90_000);

afterAll(async () => {
  await database?.destroy();
});

async function countAs(personId: string, sql: string): Promise<number> {
  return database.asPerson(personId, async (client) => {
    const { rows } = await client.query<{ count: string }>(sql);
    return Number(rows[0]?.count ?? -1);
  });
}

async function countAsOwner(sql: string): Promise<number> {
  const { rows } = await database.owner.query<{ count: string }>(sql);
  return Number(rows[0]?.count ?? -1);
}

// ---------------------------------------------------------------------------

describe('the test connection is genuinely unprivileged', () => {
  // If this block is wrong, every isolation result below is worthless.
  it('is not the database owner', async () => {
    const { rows } = await database.appUser.query<{ current_user: string; is_owner: boolean }>(`
      SELECT current_user,
             EXISTS (
               SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND pg_get_userbyid(c.relowner) = current_user
             ) AS is_owner
    `);
    expect(rows[0]?.current_user).toBe(database.appUserRole);
    expect(rows[0]?.is_owner).toBe(false);
  });

  it('is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await database.appUser.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('needs no FORCE ROW LEVEL SECURITY to be subject to policies', async () => {
    // docs/schema-tests.sql uses FORCE because it runs as owner. We do not, and must not.
    const { rows } = await database.owner.query<{ count: string }>(
      "SELECT count(*) FROM pg_class WHERE relname IN ('organizations','events','event_players') AND relforcerowsecurity",
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('the data really is there', () => {
  // Guards against the false pass: zero rows is also what an empty database returns.
  it('holds org A rows that the owner can see', async () => {
    expect(await countAsOwner('SELECT count(*) FROM events')).toBe(2);
    expect(await countAsOwner('SELECT count(*) FROM event_players')).toBe(1);
    expect(await countAsOwner('SELECT count(*) FROM rounds')).toBe(1);
    expect(await countAsOwner('SELECT count(*) FROM scorecards')).toBe(1);
    expect(await countAsOwner('SELECT count(*) FROM cup_teams')).toBe(2);
    expect(await countAsOwner('SELECT count(*) FROM player_ratings')).toBe(1);
    expect(await countAsOwner('SELECT count(*) FROM dogfight_results')).toBe(1);
  });

  it('confirms the owner bypasses RLS, which is why the owner is not used below', async () => {
    // Same query, two roles, different answers. That difference *is* RLS working.
    expect(await countAsOwner(`SELECT count(*) FROM events WHERE org_id = '${ORG_A}'`)).toBe(1);
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM events WHERE org_id = '${ORG_A}'`)).toBe(0);
  });
});

describe('an insider sees their own organization', () => {
  it('sees their org, event, players and rounds', async () => {
    expect(await countAs(INSIDER, 'SELECT count(*) FROM organizations')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM events')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM event_players')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM rounds')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM scorecards')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM cup_teams')).toBe(2);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM player_ratings')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM dogfight_results')).toBe(1);
  });

  it('sees the event by id', async () => {
    expect(await countAs(INSIDER, `SELECT count(*) FROM events WHERE id = '${EVENT_A}'`)).toBe(1);
  });
});

describe('ADVERSARIAL: org B reading org A', () => {
  // Each query names org A's rows specifically. Org B has its own event, so a blanket
  // count would pass for the wrong reason.
  const orgARows: readonly [string, string][] = [
    ['events', `org_id = '${ORG_A}'`],
    ['event_players', `event_id = '${EVENT_A}'`],
    ['event_roles', `event_id = '${EVENT_A}'`],
    ['rounds', `event_id = '${EVENT_A}'`],
    ['scorecards', `round_id = '${ROUND_A}'`],
    ['dogfight_results', `round_id = '${ROUND_A}'`],
    ['cup_teams', `event_id = '${EVENT_A}'`],
    ['player_ratings', `org_id = '${ORG_A}'`],
  ];

  it.each(orgARows)('returns zero of org A\u2019s rows from %s', async (table, where) => {
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM ${table} WHERE ${where}`)).toBe(0);
  });

  it('still sees its own event, so the policies are not simply denying everything', async () => {
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM events')).toBe(1);
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM events WHERE id = '${EVENT_B}'`)).toBe(1);
  });

  it('cannot reach org A rows even by naming the primary key', async () => {
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM events WHERE id = '${EVENT_A}'`)).toBe(0);
    expect(
      await countAs(OUTSIDER, `SELECT count(*) FROM event_players WHERE id = '${PLAYER_A}'`),
    ).toBe(0);
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM rulesets WHERE id = '${RULESET_A}'`)).toBe(0);
  });

  it('sees only its own organization', async () => {
    const rows = await database.asPerson(OUTSIDER, async (client) =>
      (await client.query<{ slug: string }>('SELECT slug FROM organizations')).rows,
    );
    expect(rows.map((row) => row.slug)).toEqual(['other']);
  });

  it('cannot see org A members', async () => {
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM org_members WHERE org_id = '${ORG_A}'`)).toBe(0);
  });

  it('cannot see another person’s sync mutations', async () => {
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM sync_mutations')).toBe(0);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM sync_mutations')).toBe(1);
  });

  it('cannot write into org A’s event', async () => {
    await expect(
      database.asPerson(OUTSIDER, (client) =>
        client.query(
          `INSERT INTO event_players (event_id, person_id, starting_ptp, starting_ptp_source)
           VALUES ($1, $2, 30, 'manual')`,
          [EVENT_A, OUTSIDER],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('cannot rename org A’s event', async () => {
    await database.asPerson(OUTSIDER, (client) =>
      client.query(`UPDATE events SET name = 'hijacked' WHERE id = $1`, [EVENT_A]),
    );
    const { rows } = await database.owner.query<{ name: string }>(
      'SELECT name FROM events WHERE id = $1',
      [EVENT_A],
    );
    expect(rows[0]?.name).toBe('DDD 2026');
  });
});

describe('an anonymous connection', () => {
  it('sees nothing at all when app.person_id is unset', async () => {
    const client = await database.appUser.connect();
    try {
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM events');
      expect(rows[0]?.count).toBe('0');
    } finally {
      client.release();
    }
  });
});

describe('what is deliberately shared', () => {
  it('lets anyone read a system preset ruleset', async () => {
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM rulesets WHERE org_id IS NULL')).toBe(1);
  });

  it('lets anyone read the shared course library', async () => {
    await database.owner.query(
      `INSERT INTO courses (org_id, name, total_holes, provenance) VALUES (NULL,'Community Course',18,'owned')`,
    );
    await database.owner.query(
      `INSERT INTO courses (org_id, name, total_holes, provenance) VALUES ($1,'Private Course',18,'owned')`,
      [ORG_A],
    );
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM courses')).toBe(1);
    expect(await countAs(INSIDER, 'SELECT count(*) FROM courses')).toBe(2);
  });
});

describe('every table is covered by RLS', () => {
  it('leaves no table with RLS enabled and no policy', async () => {
    const { rows } = await database.owner.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    `);
    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it('pins the exact set of tables with no RLS, so adding one is a deliberate act', async () => {
    const rows = (
      await database.owner.query<{ relname: string }>(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
          AND c.relname <> 'schema_migrations'
        ORDER BY c.relname
      `)
    ).rows.map((row) => row.relname);

    expect(rows).toEqual([
      // Child rows reachable only through a parent that IS protected. Leaking these needs a
      // parent id the outsider cannot obtain.
      'course_holes',
      'course_nines',
      'cup_match_players',
      'cup_sessions',
      'cup_team_members',
      'hole_score_audit',
      // `people` is global identity by design (spec part 3), but global identity does not
      // require global readability: with no policy, any authenticated connection can read
      // every person's name, email and phone across every tenant. See the test below.
      'people',
      'round_competitions',
      'tee_group_members',
      'tee_groups',
      'tee_sets',
    ]);
  });
});

describe('FINDING: the people table is readable across tenants', () => {
  // Documented rather than silently accepted. docs/schema.sql enables RLS on 17 tables and
  // `people` is not one of them, so this passes today and is the behaviour to change if the
  // decision is that it should not.
  it('lets org B read org A members’ names and email addresses', async () => {
    const rows = await database.asPerson(OUTSIDER, async (client) =>
      (
        await client.query<{ display_name: string; email: string }>(
          'SELECT display_name, email FROM people ORDER BY display_name',
        )
      ).rows,
    );
    expect(rows.map((row) => row.display_name)).toEqual(['Justin', 'Outsider']);
    expect(rows.map((row) => row.email)).toContain('j@x.com');
  });

  it('is the only unprotected table holding personal data', async () => {
    const rows = (
      await database.owner.query<{ relname: string }>(`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_name = c.relname AND col.column_name IN ('email','phone')
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
      `)
    ).rows.map((row) => row.relname);
    expect([...new Set(rows)]).toEqual(['people']);
  });
});

describe('the schema guards', () => {
  it('refuses to change a published ruleset', async () => {
    await expect(
      database.owner.query(`UPDATE rulesets SET document = '{"a":2}' WHERE id = $1`, [RULESET_A]),
    ).rejects.toThrow(/is immutable; create a new version/i);
  });

  it('allows a new version instead', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO rulesets (org_id, key, name, version, document, published_at)
         VALUES ($1,'ddd','DDD',2,'{"a":2}', now())`,
        [ORG_A],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses to put one player on two cup teams', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO cup_team_members (cup_team_id, event_player_id) VALUES ($1,$2)`,
        [TEAM_B, PLAYER_A],
      ),
    ).rejects.toThrow(/cup_one_team_per_player/i);
  });

  // Not exercised by docs/schema-tests.sql. Spec 2.3c: licensed course data may never enter
  // the shared library, and the obligation outlives the contract.
  it('refuses to publish licensed course data to the shared library', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO courses (org_id, name, total_holes, provenance, license_provider)
         VALUES (NULL,'Licensed Course',18,'licensed','golfapi.io')`,
      ),
    ).rejects.toThrow(/Licensed course data cannot be published to the shared library/i);
  });

  it('allows licensed course data scoped to one org', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO courses (org_id, name, total_holes, provenance, license_provider)
         VALUES ($1,'Licensed Course',18,'licensed','golfapi.io')`,
        [ORG_A],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses licensed course data with no provider named', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO courses (org_id, name, total_holes, provenance) VALUES ($1,'No Provider',18,'licensed')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/licensed_rows_need_provider/i);
  });

  // Not exercised by docs/schema-tests.sql. Invariant #9: scorecard photos are ephemeral.
  it('refuses to leave a finished import job holding an image', async () => {
    for (const status of ['applied', 'failed']) {
      await expect(
        database.owner.query(
          `INSERT INTO course_import_jobs (org_id, created_by, client_uuid, status, image_key)
           VALUES ($1,$2,gen_random_uuid(),$3,'scorecards/abc.jpg')`,
          [ORG_A, INSIDER, status],
        ),
      ).rejects.toThrow(/terminal_jobs_release_image/i);
    }
  });

  it('lets a job under review hold an image', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO course_import_jobs (org_id, created_by, client_uuid, status, image_key)
         VALUES ($1,$2,gen_random_uuid(),'needs_review','scorecards/abc.jpg')`,
        [ORG_A, INSIDER],
      ),
    ).resolves.toBeTruthy();
  });

  it('lets a job finish once the image is released', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO course_import_jobs (org_id, created_by, client_uuid, status, image_key)
         VALUES ($1,$2,gen_random_uuid(),'applied',NULL)`,
        [ORG_A, INSIDER],
      ),
    ).resolves.toBeTruthy();
  });

  it('sets a 48 hour expiry on a new import job', async () => {
    const { rows } = await database.owner.query<{ within_48h: boolean }>(`
      SELECT image_expires_at BETWEEN now() + interval '47 hours' AND now() + interval '49 hours'
             AS within_48h
      FROM course_import_jobs ORDER BY created_at DESC LIMIT 1
    `);
    expect(rows[0]?.within_48h).toBe(true);
  });

  it('silently ignores an attempt to change a player rating', async () => {
    // Append-only by RULE: UPDATE and DELETE do nothing rather than erroring.
    await database.owner.query('UPDATE player_ratings SET rounded_value = 99');
    await database.owner.query('DELETE FROM player_ratings');
    const { rows } = await database.owner.query<{ rounded_value: number; count: string }>(
      'SELECT rounded_value, count(*) OVER () AS count FROM player_ratings',
    );
    expect(rows[0]?.rounded_value).toBe(14);
    expect(rows[0]?.count).toBe('1');
  });

  it('refuses an event that starts without a frozen ruleset snapshot', async () => {
    await expect(
      database.owner.query(
        `INSERT INTO events (org_id, name, year, status) VALUES ($1,'No Snapshot',2027,'active')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/snapshot_required_once_started/i);
  });
});
