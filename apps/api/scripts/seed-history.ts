// Build a past event in the database from its golden fixture.
//
//   pnpm history:seed <org-slug> <year>
//
// Everything goes in through the same paths the console uses: the roster importer, the
// totals-only scorecard write from task 2.9, and the standings rebuild. Nothing here does
// arithmetic of its own — if a number comes out wrong, the product is wrong, which is the
// only reason this is worth running.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { parseRuleset, type IndividualTargetCompetition } from '@ddga/types';
import { rebuildResults } from '../src/scoring/standings.ts';
import { loadEnv } from '../src/env.ts';

const ENGINE_VERSION = '1.0.0';

const [slug, yearArg] = process.argv.slice(2);
if (slug === undefined || yearArg === undefined) {
  console.error('Usage: pnpm history:seed <org-slug> <year>');
  process.exit(1);
}
const year = Number(yearArg);

interface FixtureCase {
  player: string;
  input: { startingPtp: number; pointsPulled: (number | null)[] };
}
interface Fixture {
  fixtureId: string;
  roundsInFixture: number;
  cases: FixtureCase[];
}

const fixturePath = fileURLToPath(
  new URL(`../../../fixtures/dogfight-${String(year)}.json`, import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

/**
 * Which course each round was played on.
 *
 * The fixtures are point totals lifted from the spreadsheet and do not record the course, so
 * this is the trip's usual rotation rather than a fact from the history. It changes nothing
 * about the scoring — a totals-only round is scored from its points, not its holes — but the
 * rounds point at real courses rather than at nothing.
 */
const ROTATION = [
  'Heathland at The Legends',
  'Moorland at The Legends',
  'Parkland at The Legends',
];
const ROUND_KEYS = ['thu-am', 'fri-am', 'sat-am'];
const ROUND_NAMES = ['Thursday morning', 'Friday morning', 'Saturday morning'];

const pool = new Pool({ connectionString: loadEnv().databaseUrl });
const client: PoolClient = await pool.connect();

async function main(): Promise<void> {
  const org = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE slug = $1',
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) {
    const all = await client.query<{ slug: string }>('SELECT slug FROM organizations ORDER BY slug');
    throw new Error(`No group "${slug}". Available: ${all.rows.map((r) => r.slug).join(', ')}`);
  }

  // Act as the group's owner, as the console does for a signed-in planner.
  const owner = await client.query<{ person_id: string }>(
    `SELECT person_id FROM org_members
      WHERE org_id = $1 AND removed_at IS NULL AND role IN ('owner','admin')
      ORDER BY joined_at LIMIT 1`,
    [orgId],
  );
  const ownerId = owner.rows[0]?.person_id;
  if (ownerId === undefined) throw new Error('That group has no owner, so there is nobody to act as.');
  await client.query('SELECT set_config($1, $2, false)', ['app.person_id', ownerId]);

  const ruleset = await client.query<{ document: unknown }>(
    'SELECT document FROM rulesets WHERE org_id = $1 ORDER BY version DESC LIMIT 1',
    [orgId],
  );
  const document = ruleset.rows[0]?.document;
  if (document === undefined) throw new Error('That group has no ruleset. Run pnpm rulesets:seed.');
  const parsed = parseRuleset(document);
  const competition = parsed.competitions.find(
    (entry): entry is IndividualTargetCompetition => entry.type === 'individual_target',
  );
  if (competition === undefined) throw new Error('That ruleset has no individual competition.');

  await client.query('BEGIN');

  // An event of this year already built by this script is replaced, so a re-run is safe.
  const name = `Divot Diggers ${String(year)}`;
  await client.query('DELETE FROM events WHERE org_id = $1 AND year = $2 AND name = $3', [
    orgId,
    year,
    name,
  ]);
  const event = await client.query<{ id: string }>(
    `INSERT INTO events (org_id, name, year, status, ruleset_id, ruleset_snapshot)
     VALUES ($1,$2,$3,'completed',
             (SELECT id FROM rulesets WHERE org_id = $1 ORDER BY version DESC LIMIT 1),
             $4)
     RETURNING id`,
    [orgId, name, year, JSON.stringify(document)],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined) throw new Error('the event insert returned no id');

  // Roster. A returning player is matched by name so their history stays on one person
  // record rather than becoming a second Shon Cornwell.
  const playerIds = new Map<string, string>();
  for (const entry of fixture.cases) {
    // The console's own path, which matches a returning player by name so their history
    // stays on one person record.
    const person = await client.query<{ add_org_person: string }>(
      'SELECT add_org_person($1, $2, NULL, NULL)',
      [orgId, entry.player],
    );
    const personId = person.rows[0]?.add_org_person;
    if (personId === undefined) throw new Error(`could not place ${entry.player}`);

    const eventPlayer = await client.query<{ id: string }>(
      `INSERT INTO event_players (event_id, person_id, starting_ptp, starting_ptp_source)
       VALUES ($1,$2,$3,'manual') RETURNING id`,
      [eventId, personId, entry.input.startingPtp],
    );
    const eventPlayerId = eventPlayer.rows[0]?.id;
    if (eventPlayerId === undefined) throw new Error(`could not enter ${entry.player}`);
    playerIds.set(entry.player, eventPlayerId);
  }

  // Rounds, then the totals for each.
  for (let index = 0; index < fixture.roundsInFixture; index += 1) {
    const courseName = ROTATION[index % ROTATION.length];
    const course = await client.query<{ id: string; tee_set_id: string | null }>(
      `SELECT c.id, (SELECT t.id FROM tee_sets t
                      WHERE t.course_id = c.id AND t.name = 'Green' AND t.gender = 'mens'
                      LIMIT 1) AS tee_set_id
         FROM courses c WHERE c.org_id = $1 AND c.name = $2 LIMIT 1`,
      [orgId, courseName],
    );
    const courseId = course.rows[0]?.id ?? null;

    const round = await client.query<{ id: string }>(
      `INSERT INTO rounds (event_id, key, name, sequence, course_id, tee_set_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'completed') RETURNING id`,
      [
        eventId,
        ROUND_KEYS[index],
        ROUND_NAMES[index],
        index + 1,
        courseId,
        course.rows[0]?.tee_set_id ?? null,
      ],
    );
    const roundId = round.rows[0]?.id;
    if (roundId === undefined) throw new Error('the round insert returned no id');
    await client.query(
      `INSERT INTO round_competitions (round_id, competition_key) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [roundId, competition.id],
    );

    for (const entry of fixture.cases) {
      const points = entry.input.pointsPulled[index];
      const eventPlayerId = playerIds.get(entry.player);
      if (eventPlayerId === undefined) continue;
      const didNotPlay = points === null || points === undefined;

      // The same totals-only write the console's retroactive entry makes.
      await client.query(
        `INSERT INTO scorecards
           (round_id, event_player_id, status, did_not_play, entry_mode,
            points_pulled_manual, submitted_at)
         VALUES ($1,$2,'submitted',$3,'totals_only',$4, now())`,
        [roundId, eventPlayerId, didNotPlay, didNotPlay ? null : points],
      );
    }
  }

  await rebuildResults(client, eventId, competition, ENGINE_VERSION);
  await client.query('COMMIT');

  console.log(
    `${name}: ${String(fixture.cases.length)} players, ` +
      `${String(fixture.roundsInFixture)} rounds, scored and stored.`,
  );
}

try {
  await main();
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
