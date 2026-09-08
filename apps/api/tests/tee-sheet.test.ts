import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;

let harness: AuthHarness;
let cookies = '';
let roundId = '';
const people: { personId: string; name: string; ptp: number }[] = [];

function post(path: string, body: unknown, jar = cookies) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies: jar });
}

async function sheet() {
  const response = await harness.request(`/api/rounds/${roundId}/groups`, { cookies });
  return (await response.json()) as {
    groups: {
      id: string;
      sequence: number;
      teeTime: string | null;
      locked: boolean;
      players: { personId: string; displayName: string; startingPtp: number }[];
    }[];
    unassigned: { displayName: string }[];
  };
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_teesheet');
  const email = 'sheet@example.com';
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
  const eventId = ((await (await post('/api/events', { name: 'DDD 2027', year: 2027 })).json()) as {
    id: string;
  }).id;

  // Twelve players on distinct targets.
  const roster: [string, number][] = [
    ['Mike', 48], ['Justin', 46], ['Wayne', 41], ['Casey', 40],
    ['Elliot', 38], ['Kyle', 37], ['Peter', 33], ['Jason', 30],
    ['Shon', 29], ['Levi', 16], ['Patrick', 15], ['Kenny', 14],
  ];
  for (const [name, ptp] of roster) {
    const created = await post('/api/people', { name });
    const personId = ((await created.json()) as { id: string }).id;
    people.push({ personId, name, ptp });
    await post(`/api/events/${eventId}/players`, { personId, startingPtp: ptp, source: 'manual' });
  }

  const course = await post('/api/courses', {
    course: { name: 'Sheet Course', totalHoles: 18 },
    teeSets: [
      { name: 'Default', holes: Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4 })) },
    ],
  });
  const courseId = ((await course.json()) as { id: string }).id;
  const round = await post('/api/rounds', {
    eventId,
    courseId,
    key: 'thu-am',
    name: 'Thursday morning',
  });
  roundId = ((await round.json()) as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('before a sheet exists', () => {
  it('has no groups and everyone unassigned', async () => {
    const current = await sheet();
    expect(current.groups).toEqual([]);
    expect(current.unassigned).toHaveLength(12);
  });
});

describe('suggesting a sheet', () => {
  it('lays out six tee times ten minutes apart', async () => {
    // Six twos, to match the shape of a Cup session.
    const response = await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'balanced',
      groupSize: 2,
      firstTeeTime: '08:00',
      intervalMinutes: 10,
    });
    expect(response.status).toBe(200);

    const current = await sheet();
    expect(current.groups).toHaveLength(6);
    expect(current.groups.map((group) => group.teeTime)).toEqual([
      '08:00', '08:10', '08:20', '08:30', '08:40', '08:50',
    ]);
  });

  it('places everyone, exactly once', async () => {
    const current = await sheet();
    const placed = current.groups.flatMap((group) => group.players.map((p) => p.personId));
    expect(placed).toHaveLength(12);
    expect(new Set(placed).size).toBe(12);
    expect(current.unassigned).toEqual([]);
  });

  it('balances foursomes rather than stacking them', async () => {
    // Checked on foursomes, not pairs: with this field the two weakest are 30 apart from the
    // two strongest, so no pairing of twelve into sixes can be close. Balance is a property
    // of the arrangement, not a promise the numbers can always keep.
    await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'balanced',
      groupSize: 4,
      firstTeeTime: '08:00',
      intervalMinutes: 10,
    });
    const current = await sheet();
    const totals = current.groups.map((group) =>
      group.players.reduce((sum, player) => sum + player.startingPtp, 0),
    );
    expect(totals).toHaveLength(3);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(6);
  });

  it('spreads the strong and the weak across every foursome', async () => {
    const current = await sheet();
    for (const group of current.groups) {
      const ptps = group.players.map((player) => player.startingPtp);
      expect(Math.max(...ptps)).toBeGreaterThan(35);
      expect(Math.min(...ptps)).toBeLessThan(35);
    }
  });

  it('groups like with like when asked to instead', async () => {
    await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'similar',
      groupSize: 4,
      firstTeeTime: '07:30',
      intervalMinutes: 8,
    });
    const current = await sheet();
    expect(current.groups).toHaveLength(3);
    expect(current.groups[0]?.players.map((p) => p.displayName)).toEqual([
      'Mike', 'Justin', 'Wayne', 'Casey',
    ]);
    expect(current.groups.map((g) => g.teeTime)).toEqual(['07:30', '07:38', '07:46']);
  });

  it('replaces the sheet rather than adding to it', async () => {
    const current = await sheet();
    const placed = current.groups.flatMap((group) => group.players);
    // Still twelve, not twelve plus the earlier six-group arrangement.
    expect(placed).toHaveLength(12);
  });
});

describe('building one by hand', () => {
  it('takes the exact arrangement given', async () => {
    const byName = (name: string) => people.find((p) => p.name === name)?.personId;
    await post(`/api/rounds/${roundId}/groups`, {
      firstTeeTime: '09:00',
      intervalMinutes: 12,
      groups: [
        { personIds: [byName('Mike'), byName('Kenny')] },
        { personIds: [byName('Justin'), byName('Levi')] },
      ],
    });
    const current = await sheet();
    expect(current.groups).toHaveLength(2);
    expect(current.groups[0]?.players.map((p) => p.displayName)).toEqual(['Mike', 'Kenny']);
    expect(current.groups[1]?.teeTime).toBe('09:12');
    // The other eight are simply not out yet.
    expect(current.unassigned).toHaveLength(8);
  });
});

describe('locking the sheet', () => {
  beforeAll(async () => {
    await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'balanced',
      groupSize: 4,
      firstTeeTime: '08:00',
      intervalMinutes: 10,
    });
  });

  it('marks every group locked', async () => {
    const response = await post(`/api/rounds/${roundId}/groups/lock`, { locked: true });
    expect(response.status).toBe(200);
    const current = await sheet();
    expect(current.groups.every((group) => group.locked)).toBe(true);
  });

  it('refuses to change a locked sheet', async () => {
    const response = await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'similar',
      groupSize: 4,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/locked/i);
  });

  it('leaves the locked arrangement untouched', async () => {
    const current = await sheet();
    expect(current.groups).toHaveLength(3);
    expect(current.groups[0]?.locked).toBe(true);
  });

  it('unlocks when something changes', async () => {
    await post(`/api/rounds/${roundId}/groups/lock`, { locked: false });
    const response = await post(`/api/rounds/${roundId}/groups`, {
      strategy: 'similar',
      groupSize: 4,
    });
    expect(response.status).toBe(200);
  });
});

describe('ADVERSARIAL: another group’s tee sheet', () => {
  it('is invisible', async () => {
    const email = 'rival-sheet@example.com';
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
    await post('/api/organizations', { name: 'Rival Society' }, rival);

    const response = await harness.request(`/api/rounds/${roundId}/groups`, { cookies: rival });
    const body = (await response.json()) as { groups: unknown[]; unassigned: unknown[] };
    expect(body.groups).toEqual([]);
    expect(body.unassigned).toEqual([]);

    // And the owner still sees it, so the emptiness is RLS rather than missing data.
    const mine = await sheet();
    expect(mine.groups.length).toBeGreaterThan(0);
  });
});
