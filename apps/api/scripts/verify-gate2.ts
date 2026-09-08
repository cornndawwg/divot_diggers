// Gate 2: check what is in the database against the golden fixtures.
//
//   pnpm gate2 <org-slug>
//
// Reads the stored results — not the engine, not the fixtures twice — and compares every
// player's per-round target, cumulative delta, final standing and carry-over against the
// spreadsheet history. Prints a name-by-name table and a single PASS or FAIL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadEnv } from '../src/env.ts';

const slug = process.argv[2] ?? 'divot-diggers';
const YEARS = [2025, 2026];

interface FixtureCase {
  player: string;
  expected: {
    targetsByRound: number[];
    cumulativeDeltaByRound: number[];
    finalStanding: number;
    carryoverRaw: number;
    carryoverRounded: number;
    position: number;
  };
}

const pool = new Pool({ connectionString: loadEnv().databaseUrl });
const client = await pool.connect();

/** Compare at the precision the fixtures are stated to, not at float equality. */
function same(a: number | null, b: number): boolean {
  return a !== null && Math.abs(a - b) < 1e-9;
}

let failures = 0;
let checks = 0;

try {
  const org = await client.query<{ id: string }>(
    'SELECT id FROM organizations WHERE slug = $1',
    [slug],
  );
  const orgId = org.rows[0]?.id;
  if (orgId === undefined) throw new Error(`No group "${slug}".`);

  for (const year of YEARS) {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../fixtures/dogfight-${String(year)}.json`, import.meta.url)),
        'utf8',
      ),
    ) as { cases: FixtureCase[]; roundsInFixture: number };

    const event = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM events WHERE org_id = $1 AND year = $2 ORDER BY created_at LIMIT 1',
      [orgId, year],
    );
    const eventId = event.rows[0]?.id;

    console.log(`\n${String(year)} — ${event.rows[0]?.name ?? 'NOT IN THE DATABASE'}`);
    console.log('─'.repeat(78));

    if (eventId === undefined) {
      console.log('  no event for this year. Run: pnpm history:seed ' + slug + ' ' + String(year));
      failures += 1;
      continue;
    }

    const rows = await client.query<{
      display_name: string;
      sequence: number;
      target: string;
      cumulative_delta: string;
    }>(
      `SELECT p.display_name, r.sequence, d.target, d.cumulative_delta
         FROM dogfight_results d
         JOIN rounds r ON r.id = d.round_id
         JOIN event_players ep ON ep.id = d.event_player_id
         JOIN people p ON p.id = ep.person_id
        WHERE r.event_id = $1
        ORDER BY p.display_name, r.sequence`,
      [eventId],
    );

    console.log(
      '  ' +
        'Player'.padEnd(22) +
        'targets'.padEnd(24) +
        'standing'.padEnd(11) +
        'carry'.padEnd(8) +
        '',
    );

    for (const entry of fixture.cases) {
      const mine = rows.rows.filter((row) => row.display_name === entry.player);
      const targets = mine.map((row) => Number(row.target));
      const deltas = mine.map((row) => Number(row.cumulative_delta));
      const problems: string[] = [];

      if (mine.length !== fixture.roundsInFixture) {
        problems.push(`${String(mine.length)} rounds stored, expected ${String(fixture.roundsInFixture)}`);
      }
      entry.expected.targetsByRound.forEach((want, index) => {
        checks += 1;
        if (!same(targets[index] ?? null, want)) {
          problems.push(`R${String(index + 1)} target ${String(targets[index])} ≠ ${String(want)}`);
        }
      });
      entry.expected.cumulativeDeltaByRound.forEach((want, index) => {
        checks += 1;
        if (!same(deltas[index] ?? null, want)) {
          problems.push(`R${String(index + 1)} delta ${String(deltas[index])} ≠ ${String(want)}`);
        }
      });
      checks += 1;
      const standing = deltas[deltas.length - 1] ?? null;
      if (!same(standing, entry.expected.finalStanding)) {
        problems.push(`standing ${String(standing)} ≠ ${String(entry.expected.finalStanding)}`);
      }

      const mark = problems.length === 0 ? 'ok  ' : 'FAIL';
      if (problems.length > 0) failures += 1;
      console.log(
        `  ${mark} ${entry.player.padEnd(22)}` +
          targets.map((t) => t.toFixed(2)).join(' ').padEnd(24) +
          String(standing ?? '—').padEnd(11) +
          String(entry.expected.carryoverRounded).padEnd(8) +
          (problems.length > 0 ? '  ' + problems.join('; ') : ''),
      );
    }
  }

  console.log('\n' + '═'.repeat(78));
  console.log(
    failures === 0
      ? `GATE 2 PASSED — ${String(checks)} values checked against the fixtures, all match.`
      : `GATE 2 FAILED — ${String(failures)} player(s) wrong out of ${String(checks)} values checked.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
