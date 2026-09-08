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

  it('can delete from exactly seven tables and nowhere else', async () => {
    // A stray DELETE grant is how history quietly disappears. Every one of these is either
    // an arrangement that gets rebuilt or a cache: roster entries, the derived results, and
    // the tee sheet, which is replaced wholesale each time it is laid out. Ratings are
    // append-only, archive removal is soft, and scores are never deleted by the app at all.
    const { rows } = await database.owner.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = $1 AND privilege_type = 'DELETE' AND table_schema = 'public'
        ORDER BY table_name`,
      [database.appUserRole],
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'cup_team_members',
      'cup_teams',
      'dogfight_results',
      'event_players',
      'event_roles',
      'tee_group_members',
      'tee_groups',
    ]);
  });

  it('is refused outright when it tries to delete a score', async () => {
    await expect(database.appUser.query('DELETE FROM hole_scores')).rejects.toThrow(
      /permission denied/i,
    );
    await expect(database.appUser.query('DELETE FROM scorecards')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot destroy a rating, and since 0015 is told so out loud', async () => {
    // Two things stop this: no DELETE grant on the table, and the append-only rule. Before
    // 0015 the rule was unconditional, so Postgres dropped the statement before it ever
    // reached a permission check and the caller got a cheerful "0 rows". Now the rule is
    // conditional, the statement survives rewriting, and the missing grant refuses it
    // properly. Nothing is deleted either way; the difference is that the caller finds out.
    const before = await countAsOwner('SELECT count(*) FROM player_ratings');
    await expect(database.appUser.query('DELETE FROM player_ratings')).rejects.toThrow(
      /permission denied/i,
    );
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

  it('cannot read another organization’s course structure', async () => {
    // The parent `courses` was always protected; its children were not, so every hole of
    // every private course was readable by anyone. Measured at 567 rows before the fix.
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM tee_sets')).toBe(0);
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM course_holes')).toBe(0);
    expect(await countAsOwner('SELECT count(*) FROM course_holes')).toBeGreaterThan(0);
  });

  it('cannot see who is playing with whom, or when', async () => {
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM tee_groups')).toBe(0);
    expect(await countAs(OUTSIDER, 'SELECT count(*) FROM tee_group_members')).toBe(0);
    expect(await countAsOwner('SELECT count(*) FROM tee_groups')).toBeGreaterThan(0);
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
    // The shared one, org A's private one, and the one the seed adds for the child-table tests.
    expect(await countAs(INSIDER, 'SELECT count(*) FROM courses')).toBe(3);
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

  it('leaves no table without RLS at all', async () => {
    // This list used to hold ten child tables, on the assumption they were only reachable
    // through a protected parent. That was wrong: with no policy, a plain SELECT returns
    // every row regardless of who is asking. Migration 0011 closed it. Invariant #5 says
    // every table, and this is what holds that to account.
    const rows = (
      await database.owner.query<{ relname: string }>(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
          AND c.relname <> 'schema_migrations'
        ORDER BY c.relname
      `)
    ).rows.map((row) => row.relname);

    expect(rows).toEqual([]);
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

describe('a rating that points at an event', () => {
  // The seeded rating has no event attached, so these make their own.
  async function ratingAgainst(eventId: string, rounded: number): Promise<void> {
    await database.owner.query(
      `INSERT INTO player_ratings (org_id, person_id, competition_key, raw_value,
                                   rounded_value, after_event_id, reason)
       VALUES ($1, $2, 'dogfight', $3, $4, $5, 'event_carryover')`,
      [ORG_A, INSIDER, rounded + 0.5, rounded, eventId],
    );
  }

  async function eventLike(id: string, name: string): Promise<void> {
    await database.owner.query(
      `INSERT INTO events (id, org_id, name, year, status, ruleset_snapshot)
       SELECT $1, org_id, $2, 2029, 'draft', ruleset_snapshot FROM events WHERE id = $3`,
      [id, name, EVENT_A],
    );
  }

  it('cannot be cut loose from it by hand', async () => {
    // 0015 lets the SET NULL through. It must not also become a way for a caller to detach
    // history whenever they like, so the rule additionally requires that the event is
    // already gone — which only the referential action can ever be true for.
    await ratingAgainst(EVENT_A, 31);
    await database.owner.query(
      'UPDATE player_ratings SET after_event_id = NULL WHERE rounded_value = 31',
    );

    const { rows } = await database.owner.query<{ after_event_id: string | null }>(
      'SELECT after_event_id FROM player_ratings WHERE rounded_value = 31',
    );
    expect(rows[0]?.after_event_id).toBe(EVENT_A);
  });

  it('nor by an update dressed up to look like the referential action', async () => {
    await ratingAgainst(EVENT_A, 32);
    await database.owner.query(
      'UPDATE player_ratings SET after_event_id = NULL, rounded_value = 99 WHERE rounded_value = 32',
    );
    const { rows } = await database.owner.query<{
      after_event_id: string | null;
      rounded_value: number;
    }>('SELECT after_event_id, rounded_value FROM player_ratings WHERE rounded_value = 32');
    expect(rows[0]?.after_event_id).toBe(EVENT_A);
    expect(rows[0]?.rounded_value).toBe(32);
  });

  // Until 0015 this was impossible. after_event_id is ON DELETE SET NULL, the append-only
  // rule swallowed the UPDATE that implements it, Postgres saw its own referential query
  // come back wrong, and the whole delete aborted with "referential integrity query ... gave
  // unexpected result". A planner who set an event up by mistake was stuck with it for good.
  it('lets that event be deleted, and survives it with no event attached', async () => {
    const scratch = '11111111-1111-1111-1111-111111111111';
    await eventLike(scratch, 'Made By Mistake');
    await ratingAgainst(scratch, 33);

    await database.owner.query('DELETE FROM events WHERE id = $1', [scratch]);

    const events = await database.owner.query<{ count: string }>(
      'SELECT count(*) FROM events WHERE id = $1',
      [scratch],
    );
    expect(events.rows[0]?.count).toBe('0');

    // The history survives the event, which is why the column is SET NULL and not CASCADE.
    // A player's PTP record is not the event's to take with it.
    const rating = await database.owner.query<{ after_event_id: null }>(
      'SELECT after_event_id FROM player_ratings WHERE rounded_value = 33',
    );
    expect(rating.rows).toHaveLength(1);
    expect(rating.rows[0]?.after_event_id).toBeNull();
  });
});

describe('the guard on a scored player', () => {
  // 0008 stops a planner removing somebody whose scores would go with them. 0016 narrows it
  // so it does not also stand in the way of deleting the whole event, which cascades to the
  // same rows. Both halves matter, so both are pinned — on an event of their own, because
  // the second half destroys what it works on.
  const EVENT = '22222222-2222-2222-2222-222222222222';
  const PLAYER = '22222222-2222-2222-2222-222222222233';
  const ROUND = '22222222-2222-2222-2222-222222222244';

  beforeAll(async () => {
    await database.owner.query(
      `INSERT INTO events (id, org_id, name, year, status, ruleset_snapshot)
       SELECT $1, org_id, 'Scored And Doomed', 2030, 'draft', ruleset_snapshot
         FROM events WHERE id = $2`,
      [EVENT, EVENT_A],
    );
    await database.owner.query(
      `INSERT INTO event_players (id, event_id, person_id, starting_ptp, starting_ptp_source)
       VALUES ($1,$2,$3,30,'manual')`,
      [PLAYER, EVENT, INSIDER],
    );
    await database.owner.query(
      `INSERT INTO rounds (id, event_id, key, name, sequence) VALUES ($1,$2,'thu-am','Thursday AM',1)`,
      [ROUND, EVENT],
    );
    // A round entered as a totals-only card — exactly what the guard is there to protect.
    await database.owner.query(
      `INSERT INTO scorecards (round_id, event_player_id, status, entry_mode, points_pulled_manual)
       VALUES ($1,$2,'submitted','totals_only',41)`,
      [ROUND, PLAYER],
    );
  });

  it('still refuses to remove one player who has been scored', async () => {
    await expect(
      database.owner.query('DELETE FROM event_players WHERE id = $1', [PLAYER]),
    ).rejects.toThrow(/already has scores recorded/i);

    const { rows } = await database.owner.query<{ count: string }>(
      'SELECT count(*) FROM event_players WHERE id = $1',
      [PLAYER],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('lets the event they were scored in be deleted, scores and all', async () => {
    // Before 0016 an event became undeletable the moment anybody's first score went in, so a
    // planner who set one up by mistake was stuck with it permanently.
    await database.owner.query('DELETE FROM events WHERE id = $1', [EVENT]);

    const gone = async (sql: string): Promise<string | undefined> =>
      (await database.owner.query<{ count: string }>(sql, [EVENT])).rows[0]?.count;

    expect(await gone('SELECT count(*) FROM events WHERE id = $1')).toBe('0');
    expect(await gone('SELECT count(*) FROM event_players WHERE event_id = $1')).toBe('0');
    expect(await gone('SELECT count(*) FROM rounds WHERE event_id = $1')).toBe('0');

    const cards = await database.owner.query<{ count: string }>(
      'SELECT count(*) FROM scorecards WHERE event_player_id = $1',
      [PLAYER],
    );
    expect(cards.rows[0]?.count).toBe('0');
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
    const before = await database.owner.query<{ count: string }>(
      'SELECT count(*) FROM player_ratings',
    );
    await database.owner.query('UPDATE player_ratings SET rounded_value = 99');
    await database.owner.query('DELETE FROM player_ratings');

    const { rows } = await database.owner.query<{ rounded_value: number }>(
      'SELECT rounded_value FROM player_ratings WHERE reason = $1 AND raw_value = 14.375',
      ['event_carryover'],
    );
    expect(rows[0]?.rounded_value).toBe(14);
    const after = await database.owner.query<{ count: string }>(
      'SELECT count(*) FROM player_ratings',
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
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
