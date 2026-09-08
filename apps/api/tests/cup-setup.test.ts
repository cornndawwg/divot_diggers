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
const people = new Map<string, string>();

function post(path: string, body?: unknown) {
  return harness.request(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cookies,
  });
}

async function cup() {
  const response = await harness.request(`/api/events/${eventId}/cup`, { cookies });
  return (await response.json()) as {
    name: string;
    sessions: { roundId: string; format: string; holes: number; playersPerSide: number }[];
    teams: {
      id: string;
      key: string;
      name: string;
      captainPersonId: string | null;
      captainName: string | null;
      players: { personId: string; displayName: string; isCaptain: boolean; startingPtp: number }[];
      totalPtp: number;
    }[];
    unassigned: { personId: string; displayName: string }[];
    balance: { perTeam: number; pointsAvailable: number; clinchThreshold: number; issues: string[] };
  };
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_cup');
  const email = 'captain@example.com';
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
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('the cup as the rules describe it', () => {
  it('creates the two sides from the ruleset the first time it is opened', async () => {
    const body = await cup();
    expect(body.name).toBe('Winona Ryder Cup');
    expect(body.teams.map((team) => team.name)).toEqual([
      'Inglorious Bogies',
      'Bad Birdies',
    ]);
    expect(body.teams.every((team) => team.players.length === 0)).toBe(true);
    expect(body.unassigned).toHaveLength(12);
  });

  it('describes the three nine-hole sessions', async () => {
    const body = await cup();
    expect(body.sessions).toEqual([
      { roundId: 'thu-pm', format: 'scramble', playersPerSide: 2, holes: 9, declaredMatches: 6 },
      { roundId: 'fri-pm', format: 'alternate_shot', playersPerSide: 2, holes: 9, declaredMatches: 6 },
      { roundId: 'sat-pm', format: 'singles', playersPerSide: 1, holes: 9, declaredMatches: 12 },
    ]);
  });

  it('sizes the cup from who turned up, not from the rules', async () => {
    const body = await cup();
    // Twelve players is six a side: 3 + 3 + 6 matches, not the 6 + 6 + 12 of a full year.
    expect(body.balance.perTeam).toBe(6);
    expect(body.balance.pointsAvailable).toBe(12);
    expect(body.balance.clinchThreshold).toBe(7);
  });
});

describe('naming the sides and appointing captains', () => {
  it('renames a side', async () => {
    const before = await cup();
    const team = before.teams[0];
    const response = await post(`/api/events/${eventId}/cup/teams/${team?.id}`, {
      name: 'The Slicers',
    });
    expect(response.status).toBe(200);
    expect((await cup()).teams[0]?.name).toBe('The Slicers');
  });

  it('appoints a captain, and puts them on the side they captain', async () => {
    const before = await cup();
    const team = before.teams[0];
    await post(`/api/events/${eventId}/cup/teams/${team?.id}`, {
      captainPersonId: people.get('Mike'),
    });

    const after = await cup();
    const captained = after.teams[0];
    expect(captained?.captainName).toBe('Mike');
    expect(captained?.players.map((player) => player.displayName)).toContain('Mike');
    expect(captained?.players.find((player) => player.displayName === 'Mike')?.isCaptain).toBe(true);
  });

  it('gives the other side its own captain', async () => {
    const before = await cup();
    await post(`/api/events/${eventId}/cup/teams/${before.teams[1]?.id}`, {
      captainPersonId: people.get('Justin'),
    });
    const after = await cup();
    expect(after.teams[1]?.captainName).toBe('Justin');
    expect(after.unassigned.map((player) => player.displayName)).not.toContain('Justin');
  });

  it('refuses a captain who is not on the roster', async () => {
    const stranger = await post('/api/people', { name: 'Not Playing' });
    const strangerId = ((await stranger.json()) as { id: string }).id;
    const body = await cup();
    const response = await post(`/api/events/${eventId}/cup/teams/${body.teams[0]?.id}`, {
      captainPersonId: strangerId,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/on the roster first/);
  });
});

describe('assigning players', () => {
  it('puts somebody on a side', async () => {
    const before = await cup();
    await post(`/api/events/${eventId}/cup/assign`, {
      personId: people.get('Kenny'),
      teamId: before.teams[1]?.id,
    });
    const after = await cup();
    expect(after.teams[1]?.players.map((player) => player.displayName)).toContain('Kenny');
  });

  it('moves them rather than putting them on both', async () => {
    const before = await cup();
    await post(`/api/events/${eventId}/cup/assign`, {
      personId: people.get('Kenny'),
      teamId: before.teams[0]?.id,
    });
    const after = await cup();
    expect(after.teams[0]?.players.map((p) => p.displayName)).toContain('Kenny');
    expect(after.teams[1]?.players.map((p) => p.displayName)).not.toContain('Kenny');
  });

  it('takes them off entirely when no side is given', async () => {
    await post(`/api/events/${eventId}/cup/assign`, { personId: people.get('Kenny'), teamId: null });
    const after = await cup();
    expect(after.unassigned.map((player) => player.displayName)).toContain('Kenny');
  });

  it('gives up the captaincy when a captain is taken off', async () => {
    const before = await cup();
    const team = before.teams[0];
    expect(team?.captainName).toBe('Mike');
    await post(`/api/events/${eventId}/cup/assign`, { personId: people.get('Mike'), teamId: null });
    const after = await cup();
    expect(after.teams[0]?.captainPersonId).toBeNull();
  });
});

describe('splitting the field evenly', () => {
  it('places everybody, six a side', async () => {
    const response = await post(`/api/events/${eventId}/cup/suggest`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { placed: number }).placed).toBe(12);

    const after = await cup();
    expect(after.teams.map((team) => team.players.length)).toEqual([6, 6]);
    expect(after.unassigned).toEqual([]);
  });

  it('makes the sides close on combined target', async () => {
    const after = await cup();
    const gap = Math.abs((after.teams[0]?.totalPtp ?? 0) - (after.teams[1]?.totalPtp ?? 0));
    expect(gap).toBeLessThanOrEqual(2);
  });

  it('appoints no captains, because that is a decision and not arithmetic', async () => {
    const after = await cup();
    expect(after.teams.every((team) => team.captainPersonId === null)).toBe(true);
  });
});

describe('ADVERSARIAL: another group’s cup', () => {
  it('is invisible', async () => {
    const email = 'rival-cup@example.com';
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Rival' }),
    });
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
    const rival = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'correct-horse-battery' }),
      }),
    );
    await harness.request('/api/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Rival Society' }),
      cookies: rival,
    });

    const response = await harness.request(`/api/events/${eventId}/cup`, { cookies: rival });
    // No event of theirs, so no cup config to read: refused rather than leaked.
    expect(response.status).toBe(409);

    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM cup_team_members',
    );
    expect(Number(rows[0]?.count)).toBe(12);
  });
});
