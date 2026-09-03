import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  seed,
  EVENT_A,
  EVENT_B,
  GUEST,
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

  it('can delete from exactly the two roster tables and nowhere else', async () => {
    // A stray DELETE grant is how history quietly disappears. Ratings are append-only,
    // archive removal is soft, and scores are never deleted by the app at all.
    const { rows } = await database.owner.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = $1 AND privilege_type = 'DELETE' AND table_schema = 'public'
        ORDER BY table_name`,
      [database.appUserRole],
    );
    expect(rows.map((row) => row.table_name)).toEqual(['event_players', 'event_roles']);
  });

  it('is refused outright when it tries to delete a score', async () => {
    await expect(database.appUser.query('DELETE FROM hole_scores')).rejects.toThrow(
      /permission denied/i,
    );
    await expect(database.appUser.query('DELETE FROM scorecards')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot destroy a rating, though the refusal is silent rather than loud', async () => {
    // player_ratings carries DO INSTEAD NOTHING rules, so a delete succeeds and removes
    // nothing. Worth pinning: "it worked" and "it did nothing" look identical to a caller.
    const before = await countAsOwner('SELECT count(*) FROM player_ratings');
    await database.appUser.query('DELETE FROM player_ratings');
    expect(await countAsOwner('SELECT count(*) FROM player_ratings')).toBe(before);
    expect(before).toBeGreaterThan(0);
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
    expect(await countAsOwner('SELECT count(*) FROM event_players')).toBe(2);
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
    expect(await countAs(INSIDER, 'SELECT count(*) FROM event_players')).toBe(2);
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
      'round_competitions',
      'tee_group_members',
      'tee_groups',
      'tee_sets',
    ]);
  });
});

describe('the people table, since migration 0003', () => {
  it('no longer lets org B read org A members', async () => {
    const rows = await database.asPerson(OUTSIDER, async (client) =>
      (
        await client.query<{ display_name: string }>('SELECT display_name FROM people ORDER BY 1')
      ).rows,
    );
    // Only themselves. Justin and the guest are both invisible.
    expect(rows.map((row) => row.display_name)).toEqual(['Outsider']);
  });

  it('leaks no email address across tenants', async () => {
    expect(
      await countAs(OUTSIDER, `SELECT count(*) FROM people WHERE email = 'j@x.com'`),
    ).toBe(0);
    // The row is really there; it is RLS hiding it.
    expect(await countAsOwner(`SELECT count(*) FROM people WHERE email = 'j@x.com'`)).toBe(1);
  });

  it('still lets a person read themselves', async () => {
    expect(await countAs(INSIDER, `SELECT count(*) FROM people WHERE id = '${INSIDER}'`)).toBe(1);
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM people WHERE id = '${OUTSIDER}'`)).toBe(1);
  });

  it('still lets org-mates read each other', async () => {
    await database.owner.query(
      `INSERT INTO people (id, display_name, email) VALUES ($1,'Team Mate','t@x.com')`,
      ['aaaaaaaa-0000-0000-0000-000000000009'],
    );
    await database.owner.query(
      `INSERT INTO org_members (org_id, person_id, role) VALUES ($1,$2,'member')`,
      [ORG_A, 'aaaaaaaa-0000-0000-0000-000000000009'],
    );
    expect(
      await countAs(INSIDER, `SELECT count(*) FROM people WHERE display_name = 'Team Mate'`),
    ).toBe(1);
    expect(
      await countAs(OUTSIDER, `SELECT count(*) FROM people WHERE display_name = 'Team Mate'`),
    ).toBe(0);
  });

  it('still shows a guest player, who is on the roster but in no organization', async () => {
    // The leaderboard case: a guest with no org membership must not render as a blank name.
    expect(await countAsOwner(`SELECT count(*) FROM org_members WHERE person_id = '${GUEST}'`)).toBe(0);
    expect(await countAs(INSIDER, `SELECT count(*) FROM people WHERE id = '${GUEST}'`)).toBe(1);
    expect(await countAs(OUTSIDER, `SELECT count(*) FROM people WHERE id = '${GUEST}'`)).toBe(0);
  });

  it('lets a person edit their own profile', async () => {
    await database.asPerson(INSIDER, (client) =>
      client.query(`UPDATE people SET phone = '555-0100' WHERE id = $1`, [INSIDER]),
    );
    const { rows } = await database.owner.query<{ phone: string }>(
      'SELECT phone FROM people WHERE id = $1',
      [INSIDER],
    );
    expect(rows[0]?.phone).toBe('555-0100');
  });

  it('refuses to let one person edit another', async () => {
    await database.asPerson(OUTSIDER, (client) =>
      client.query(`UPDATE people SET display_name = 'hijacked' WHERE id = $1`, [INSIDER]),
    );
    const { rows } = await database.owner.query<{ display_name: string }>(
      'SELECT display_name FROM people WHERE id = $1',
      [INSIDER],
    );
    expect(rows[0]?.display_name).toBe('Justin');
  });

  it('hides a removed member from another organization entirely', async () => {
    // Migration 0009 lets an OWNER see who they removed. It must not leak further.
    await database.owner.query(
      `INSERT INTO people (id, display_name, email) VALUES ($1,'Removed Person','rm@x.com')`,
      ['aaaaaaaa-0000-0000-0000-00000000000f'],
    );
    await database.owner.query(
      `INSERT INTO org_members (org_id, person_id, role, removed_at)
       VALUES ($1,$2,'member', now())`,
      [ORG_A, 'aaaaaaaa-0000-0000-0000-00000000000f'],
    );

    // Org A's owner can see them, to put them back.
    expect(
      await countAs(INSIDER, `SELECT count(*) FROM people WHERE display_name = 'Removed Person'`),
    ).toBe(1);
    // Org B cannot.
    expect(
      await countAs(OUTSIDER, `SELECT count(*) FROM people WHERE display_name = 'Removed Person'`),
    ).toBe(0);
  });

  it('leaves no unprotected table holding personal data', async () => {
    const rows = (
      await database.owner.query<{ relname: string }>(`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_name = c.relname AND col.column_name IN ('email','phone')
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
      `)
    ).rows.map((row) => row.relname);
    expect([...new Set(rows)]).toEqual([]);
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
