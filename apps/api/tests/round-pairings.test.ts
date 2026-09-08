import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;

let harness: AuthHarness;
let cookies = '';
let eventId = '';
let amRound = '';
let scrambleRound = '';
let singlesRound = '';
const people = new Map<string, string>();

function post(path: string, body?: unknown) {
  return harness.request(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cookies,
  });
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_pairings');
  const email = 'pairings@example.com';
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'The Planner' }),
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
  eventId = ((await (await post('/api/events', { name: 'DDD 2027', year: 2027 })).json()) as {
    id: string;
  }).id;

  // Twelve players, so both sides field six.
  const roster: [string, number][] = [
    ['Mike', 48], ['Justin', 46], ['Wayne', 41], ['Casey', 40],
    ['Elliot', 38], ['Kyle', 37], ['Peter', 33], ['Jason', 30],
    ['Shon', 29], ['Levi', 16], ['Patrick', 15], ['Kenny', 14],
  ];
  for (const [name, ptp] of roster) {
    const created = await post('/api/people', { name });
    const personId = ((await created.json()) as { id: string }).id;
    people.set(name, personId);
    await post(`/api/events/${eventId}/players`, { personId, startingPtp: ptp, source: 'manual' });
  }

  const course = await post('/api/courses', {
    course: { name: 'Pairing Course', totalHoles: 18 },
    teeSets: [
      {
        name: 'Green',
        holes: Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 })),
      },
    ],
  });
  const courseId = ((await course.json()) as { id: string }).id;

  // One of each: a morning eighteen that feeds only the individual competition, and two cup
  // sessions — a pairs format and singles, which want different shaped groups.
  const makeRound = async (key: string, name: string, holeSelection?: unknown) =>
    ((await (
      await post('/api/rounds', {
        eventId,
        courseId,
        key,
        name,
        ...(holeSelection === undefined ? {} : { holeSelection }),
      })
    ).json()) as { id: string }).id;

  amRound = await makeRound('thu-am', 'Thursday morning');
  scrambleRound = await makeRound('thu-pm', 'Thursday scramble', { mode: 'front9' });
  singlesRound = await makeRound('sat-pm', 'Saturday singles', { mode: 'front9' });
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

interface Sheet {
  mode: { kind: string; formatName: string | null; playersPerSide: number | null };
  teams: { key: string; name: string }[];
  groups: {
    sequence: number;
    players: { personId: string; displayName: string; teamKey: string | null }[];
  }[];
  unassigned: { personId: string; displayName: string; teamKey: string | null }[];
  warnings: string[];
}

async function sheet(roundId: string): Promise<Sheet> {
  const response = await harness.request(`/api/rounds/${roundId}/groups`, { cookies });
  return (await response.json()) as Sheet;
}

/** The two sides, keyed as the ruleset names them. */
async function teamIds(): Promise<string[]> {
  const response = await harness.request(`/api/events/${eventId}/cup`, { cookies });
  return ((await response.json()) as { teams: { id: string }[] }).teams.map((team) => team.id);
}

describe('which competition a round feeds', () => {
  it('reads a morning eighteen as an individual round', async () => {
    expect((await sheet(amRound)).mode).toEqual({
      kind: 'individual',
      sessionId: null,
      formatName: null,
      playersPerSide: null,
    });
  });

  it('reads the afternoon nine as the cup session the ruleset says it is', async () => {
    const scramble = (await sheet(scrambleRound)).mode;
    expect(scramble.kind).toBe('match_play');
    expect(scramble.formatName).toBe('scramble');
    expect(scramble.playersPerSide).toBe(2);

    const singles = (await sheet(singlesRound)).mode;
    expect(singles.formatName).toBe('singles');
    expect(singles.playersPerSide).toBe(1);
  });

  it('records what each round feeds, so scoring is not left guessing', async () => {
    const { rows } = await harness.privilegedPool.query<{ key: string; competition_key: string }>(
      `SELECT r.key, rc.competition_key FROM round_competitions rc
         JOIN rounds r ON r.id = rc.round_id WHERE r.event_id = $1 ORDER BY r.key, rc.competition_key`,
      [eventId],
    );
    expect(rows).toEqual([
      { key: 'sat-pm', competition_key: 'wrc' },
      { key: 'thu-am', competition_key: 'dogfight' },
      { key: 'thu-pm', competition_key: 'wrc' },
    ]);
  });
});

describe('a cup round with nobody on a team', () => {
  it('says so rather than inventing groups', async () => {
    const response = await post(`/api/rounds/${scrambleRound}/groups`, {});
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('Cup page');
  });

  it('still groups the individual round, which needs no teams', async () => {
    const response = await post(`/api/rounds/${amRound}/groups`, { strategy: 'balanced' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { groups: number }).groups).toBe(3);
  });
});

describe('once the sides are set', () => {
  beforeAll(async () => {
    await post(`/api/events/${eventId}/cup/suggest`, {});
  });

  it('pairs a scramble as two against two, never a mixed group', async () => {
    await post(`/api/rounds/${scrambleRound}/groups`, {});
    const current = await sheet(scrambleRound);

    expect(current.groups).toHaveLength(3);
    for (const group of current.groups) {
      expect(group.players).toHaveLength(4);
      const sides = group.players.map((player) => player.teamKey);
      const counts = new Map<string | null, number>();
      for (const side of sides) counts.set(side, (counts.get(side) ?? 0) + 1);
      expect([...counts.values()].sort()).toEqual([2, 2]);
    }
    expect(current.warnings).toEqual([]);
  });

  it('puts two singles matches in a group, so singles day is six tee times not twelve', async () => {
    await post(`/api/rounds/${singlesRound}/groups`, {});
    const current = await sheet(singlesRound);

    expect(current.groups).toHaveLength(3);
    for (const group of current.groups) {
      const counts = new Map<string | null, number>();
      for (const player of group.players) {
        counts.set(player.teamKey, (counts.get(player.teamKey) ?? 0) + 1);
      }
      expect([...counts.values()].sort()).toEqual([2, 2]);
    }
    expect(current.warnings).toEqual([]);
  });

  it('leaves an individual round free of teams entirely', async () => {
    await post(`/api/rounds/${amRound}/groups`, { strategy: 'random', groupSize: 4 });
    const current = await sheet(amRound);

    expect(current.mode.kind).toBe('individual');
    expect(current.teams).toEqual([]);
    expect(current.warnings).toEqual([]);
    // Everybody is out, and nobody carries a side on a round where sides do not exist.
    expect(current.groups.flatMap((group) => group.players)).toHaveLength(12);
    expect(current.groups.flatMap((g) => g.players).every((p) => p.teamKey === null)).toBe(true);
  });
});

describe('a hand-made sheet', () => {
  it('is saved exactly as given, even when it is not an even draw', async () => {
    const ids = [...people.values()];
    // Deliberately lopsided: the first six in one group, the rest in another. A captain who
    // does this means it.
    await post(`/api/rounds/${scrambleRound}/groups`, {
      groups: [{ personIds: ids.slice(0, 6) }, { personIds: ids.slice(6) }],
    });
    const current = await sheet(scrambleRound);

    expect(current.groups).toHaveLength(2);
    expect(current.groups[0]?.players).toHaveLength(6);
  });

  it('warns about what it did, without refusing it', async () => {
    const current = await sheet(scrambleRound);
    expect(current.warnings.length).toBeGreaterThan(0);
    expect(current.warnings.join(' ')).toMatch(/side|match|team/i);
  });

  it('accepts an empty sheet, so a planner can start from nothing', async () => {
    const response = await post(`/api/rounds/${singlesRound}/groups`, {
      groups: [{ personIds: [] }, { personIds: [] }],
    });
    expect(response.status).toBe(200);

    const current = await sheet(singlesRound);
    expect(current.groups).toHaveLength(2);
    expect(current.groups.every((group) => group.players.length === 0)).toBe(true);
    expect(current.unassigned).toHaveLength(12);
    // Everybody on a team but nobody on the course is exactly the thing to say out loud.
    expect(current.warnings.join(' ')).toContain('not out on the course');
  });

  it('still refuses to change a locked sheet, however it was made', async () => {
    await post(`/api/rounds/${singlesRound}/groups/lock`, { locked: true });
    const response = await post(`/api/rounds/${singlesRound}/groups`, {
      groups: [{ personIds: [...people.values()] }],
    });
    expect(response.status).toBe(409);
    await post(`/api/rounds/${singlesRound}/groups/lock`, { locked: false });
  });
});

describe('a captain, not just the planner', () => {
  it('may arrange the tee sheet', async () => {
    const [teamA] = await teamIds();
    expect(teamA).toBeDefined();

    // A second person, made a captain of this event and nothing more.
    const email = 'skipper@example.com';
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'The Skipper' }),
    });
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });

    const { rows } = await harness.privilegedPool.query<{ id: string }>(
      'SELECT id FROM people WHERE email = $1',
      [email],
    );
    const personId = rows[0]?.id;
    expect(personId).toBeDefined();
    // A captain is a member of the group and a captain of this event. Nothing more: no
    // planner role, and no say over the roster or anybody's score.
    await harness.privilegedPool.query(
      `INSERT INTO org_members (org_id, person_id, role)
       SELECT org_id, $2, 'member' FROM events WHERE id = $1
       ON CONFLICT DO NOTHING`,
      [eventId, personId],
    );
    await harness.privilegedPool.query(
      `INSERT INTO event_roles (event_id, person_id, role) VALUES ($1,$2,'captain')
       ON CONFLICT DO NOTHING`,
      [eventId, personId],
    );

    const captainCookies = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correct-horse-battery' }),
      }),
    );

    const ids = [...people.values()];
    const response = await harness.request(`/api/rounds/${scrambleRound}/groups`, {
      method: 'POST',
      body: JSON.stringify({
        groups: [{ personIds: ids.slice(0, 4) }, { personIds: ids.slice(4, 8) }],
      }),
      cookies: captainCookies,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { groups: number }).groups).toBe(2);
  });

  it('but an ordinary player still cannot', async () => {
    // The same setup as the captain, minus the captaincy. If this passes, the widened policy
    // opened the sheet to the whole field rather than to captains.
    const email = 'bystander@example.com';
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'A Bystander' }),
    });
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });

    const { rows } = await harness.privilegedPool.query<{ id: string }>(
      'SELECT id FROM people WHERE email = $1',
      [email],
    );
    await harness.privilegedPool.query(
      `INSERT INTO org_members (org_id, person_id, role)
       SELECT org_id, $2, 'member' FROM events WHERE id = $1 ON CONFLICT DO NOTHING`,
      [eventId, rows[0]?.id],
    );
    await harness.privilegedPool.query(
      `INSERT INTO event_roles (event_id, person_id, role) VALUES ($1,$2,'player')
       ON CONFLICT DO NOTHING`,
      [eventId, rows[0]?.id],
    );

    const theirCookies = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correct-horse-battery' }),
      }),
    );

    const response = await harness.request(`/api/rounds/${scrambleRound}/groups`, {
      method: 'POST',
      body: JSON.stringify({ groups: [{ personIds: [...people.values()] }] }),
      cookies: theirCookies,
    });
    expect(response.status).toBe(403);
  });
});

