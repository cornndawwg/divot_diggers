import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

/**
 * Task 2.9's verification, end to end through the API: build the 2025 event, enter each round
 * as points totals with no hole detail, and require the standings the database produces to
 * match fixtures/dogfight-2025.json exactly.
 *
 * Nothing here reads the fixture's expected values into the app. The roster's starting targets
 * and the points pulled go in; every target, delta, standing, position and carry-over value
 * comes back out of the engine by way of the API.
 */

const ROOT = new URL('../../../', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, ROOT)), 'utf8'));
}

interface Case {
  player: string;
  input: { startingPtp: number; pointsPulled: number[] };
  expected: {
    targetsByRound: number[];
    cumulativeDeltaByRound: number[];
    finalStanding: number;
    carryoverRaw: number;
    carryoverRounded: number;
    position: number;
  };
}

const RULESET = fixture('divot-diggers-ruleset.json') as Record<string, unknown>;
const YEAR_2025 = fixture('fixtures/dogfight-2025.json') as { cases: Case[] };

let harness: AuthHarness;
let cookies = '';
let eventId = '';
const roundIds: string[] = [];
const personIds = new Map<string, string>();

function post(path: string, body: unknown) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_retro');

  const email = 'archivist@example.com';
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'The Archivist' }),
  });
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
  cookies = cookiesFrom(
    await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    }),
  );

  await post('/api/organizations', { name: 'Divot Diggers' });
  await post('/api/rulesets', RULESET);
  eventId = ((await (await post('/api/events', { name: 'DDD 2025', year: 2025 })).json()) as {
    id: string;
  }).id;

  // The roster: each 2025 player at the target they actually started on.
  for (const entry of YEAR_2025.cases) {
    const created = await post('/api/people', { name: entry.player });
    const personId = ((await created.json()) as { id: string }).id;
    personIds.set(entry.player, personId);
    await post(`/api/events/${eventId}/players`, {
      personId,
      startingPtp: entry.input.startingPtp,
      source: 'manual',
    });
  }

  // Three rounds, matching the ruleset's round keys.
  const course = await post('/api/courses', {
    course: { name: 'Backfill', totalHoles: 18 },
    teeSets: [
      {
        name: 'Default',
        holes: Array.from({ length: 18 }, (_, index) => ({ holeNumber: index + 1, par: 4 })),
      },
    ],
  });
  const courseId = ((await course.json()) as { id: string }).id;

  for (const key of ['thu-am', 'fri-am', 'sat-am']) {
    const round = await post('/api/rounds', {
      eventId,
      courseId,
      key,
      name: key,
      holeSelection: { mode: 'all' },
    });
    roundIds.push(((await round.json()) as { id: string }).id);
  }
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

async function standings() {
  const response = await harness.request(`/api/events/${eventId}/standings`, { cookies });
  return (await response.json()) as {
    rounds: { key: string }[];
    standings: {
      displayName: string;
      position: number | null;
      finalStanding: number;
      carryoverRaw: number;
      carryoverRounded: number;
      rounds: { target: number; pointsPulled: number | null; runningTotal: number }[];
    }[];
  };
}

describe('entering 2025 as totals only', () => {
  it('has the roster and three rounds', async () => {
    const response = await harness.request(`/api/events/${eventId}/players`, { cookies });
    const body = (await response.json()) as { players: unknown[] };
    expect(body.players).toHaveLength(YEAR_2025.cases.length);
    expect(roundIds).toHaveLength(3);
  });

  it('accepts each round as a list of point totals', async () => {
    for (const [index, roundId] of roundIds.entries()) {
      const totals = YEAR_2025.cases.map((entry) => ({
        personId: personIds.get(entry.player),
        pointsPulled: entry.input.pointsPulled[index],
      }));
      const response = await post(`/api/rounds/${roundId}/totals`, { totals });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { saved: number }).saved).toBe(YEAR_2025.cases.length);
    }
  });

  it('records them as totals_only, not as a card that was kept', async () => {
    const { rows } = await harness.privilegedPool.query<{
      entry_mode: string;
      count: string;
    }>(
      `SELECT entry_mode, count(*) FROM scorecards s JOIN rounds r ON r.id = s.round_id
        WHERE r.event_id = $1 GROUP BY entry_mode`,
      [eventId],
    );
    expect(rows).toEqual([
      { entry_mode: 'totals_only', count: String(YEAR_2025.cases.length * 3) },
    ]);
  });

  it('holds no hole detail at all, because none was entered', async () => {
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM hole_scores h JOIN scorecards s ON s.id = h.scorecard_id
         JOIN rounds r ON r.id = s.round_id WHERE r.event_id = $1`,
      [eventId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('the standings the database produces', () => {
  it('matches every player-round target from the fixture', async () => {
    const { standings: table } = await standings();
    for (const entry of YEAR_2025.cases) {
      const row = table.find((player) => player.displayName === entry.player);
      expect(row, entry.player).toBeDefined();
      expect(
        row?.rounds.map((round) => round.target),
        `${entry.player} targets`,
      ).toEqual(entry.expected.targetsByRound);
    }
  });

  it('matches every cumulative delta', async () => {
    const { standings: table } = await standings();
    for (const entry of YEAR_2025.cases) {
      const row = table.find((player) => player.displayName === entry.player);
      expect(
        row?.rounds.map((round) => round.runningTotal),
        `${entry.player} running totals`,
      ).toEqual(entry.expected.cumulativeDeltaByRound);
    }
  });

  it('matches every final standing', async () => {
    const { standings: table } = await standings();
    for (const entry of YEAR_2025.cases) {
      const row = table.find((player) => player.displayName === entry.player);
      expect(row?.finalStanding, entry.player).toBe(entry.expected.finalStanding);
    }
  });

  it('matches every carry-over value, raw and rounded', async () => {
    const { standings: table } = await standings();
    for (const entry of YEAR_2025.cases) {
      const row = table.find((player) => player.displayName === entry.player);
      expect(row?.carryoverRaw, `${entry.player} raw`).toBe(entry.expected.carryoverRaw);
      expect(row?.carryoverRounded, `${entry.player} rounded`).toBe(
        entry.expected.carryoverRounded,
      );
    }
  });

  it('matches every position, so the order is the fixture’s order', async () => {
    const { standings: table } = await standings();
    for (const entry of YEAR_2025.cases) {
      const row = table.find((player) => player.displayName === entry.player);
      expect(row?.position, entry.player).toBe(entry.expected.position);
    }
  });

  it('puts the winner first', async () => {
    const { standings: table } = await standings();
    const winner = YEAR_2025.cases.find((entry) => entry.expected.position === 1);
    expect(table[0]?.displayName).toBe(winner?.player);
  });
});

describe('the results cache', () => {
  it('holds a row per player per round', async () => {
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM dogfight_results d JOIN rounds r ON r.id = d.round_id
        WHERE r.event_id = $1`,
      [eventId],
    );
    expect(rows[0]?.count).toBe(String(YEAR_2025.cases.length * 3));
  });

  it('agrees with the fixture on the final round', async () => {
    const { rows } = await harness.privilegedPool.query<{
      display_name: string;
      cumulative_delta: string;
      position: number | null;
    }>(
      `SELECT p.display_name, d.cumulative_delta, d.position
         FROM dogfight_results d
         JOIN rounds r ON r.id = d.round_id
         JOIN event_players ep ON ep.id = d.event_player_id
         JOIN people p ON p.id = ep.person_id
        WHERE r.event_id = $1 AND r.key = 'sat-am'`,
      [eventId],
    );
    for (const entry of YEAR_2025.cases) {
      const row = rows.find((candidate) => candidate.display_name === entry.player);
      expect(Number(row?.cumulative_delta), entry.player).toBe(entry.expected.finalStanding);
      expect(row?.position, entry.player).toBe(entry.expected.position);
    }
  });

  it('stamps the engine version, so a future fix is traceable', async () => {
    const { rows } = await harness.privilegedPool.query<{ engine_version: string }>(
      `SELECT DISTINCT engine_version FROM dogfight_results d JOIN rounds r ON r.id = d.round_id
        WHERE r.event_id = $1`,
      [eventId],
    );
    expect(rows.map((row) => row.engine_version)).toEqual(['1.0.0']);
  });

  it('is rebuilt rather than accumulated when a round is re-entered', async () => {
    const roundId = roundIds[0];
    const totals = YEAR_2025.cases.map((entry) => ({
      personId: personIds.get(entry.player),
      pointsPulled: entry.input.pointsPulled[0],
    }));
    await post(`/api/rounds/${roundId}/totals`, { totals });

    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM dogfight_results d JOIN rounds r ON r.id = d.round_id
        WHERE r.event_id = $1`,
      [eventId],
    );
    expect(rows[0]?.count).toBe(String(YEAR_2025.cases.length * 3));
  });
});
