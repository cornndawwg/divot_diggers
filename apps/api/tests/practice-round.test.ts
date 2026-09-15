import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;
const COURSE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../seed/caledonia.json', import.meta.url)), 'utf8'),
) as unknown;

/**
 * The round on the first day that is just golf.
 *
 * Everyone arrives, plays eighteen, gets a feel for the place, and none of it counts. The
 * danger is not that it scores wrongly — it is that it scores at all, or that it looks
 * exactly like the bug where a round fed no competition and silently counted for nothing.
 */
let harness: AuthHarness;
let cookies = '';
let eventId = '';
let courseId = '';

const PASSWORD = 'correct-horse-battery';

function post(path: string, body: unknown) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_practice');
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD, name: 'The Admin' }),
  });
  const link = linkFrom(harness.mailer.lastTo('admin@example.com')?.text ?? '');
  await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
  cookies = cookiesFrom(
    await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD }),
    }),
  );

  await post('/api/organizations', { name: 'Divot Diggers' });
  await post('/api/rulesets', RULESET);
  eventId = ((await (await post('/api/events', { name: 'DDD 2027', year: 2027 })).json()) as {
    id: string;
  }).id;
  await post('/api/courses', COURSE);
  const courses = (await (await harness.request('/api/courses', { cookies })).json()) as {
    courses: { id: string }[];
  };
  courseId = courses.courses[0]?.id ?? '';

  await post(`/api/events/${eventId}/roster/import`, {
    rows: [
      { name: 'Levi Livermont', startingPtp: 16 },
      { name: 'Elliot Griffiths', startingPtp: 38 },
    ],
  });
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

async function rounds() {
  return (await (
    await harness.request(`/api/events/${eventId}/rounds`, { cookies })
  ).json()) as {
    rounds: { id: string; key: string; name: string; isPractice: boolean; feedsNothing: boolean }[];
  };
}

describe('scheduling one', () => {
  it('is created, and says plainly that it does not count', async () => {
    const response = await post('/api/rounds', {
      eventId,
      courseId,
      name: 'Wednesday practice',
      isPractice: true,
      holeSelection: { mode: 'all' },
    });
    expect(response.status).toBeLessThan(400);

    const listed = (await rounds()).rounds;
    const practice = listed.find((r) => r.name === 'Wednesday practice');
    expect(practice?.isPractice).toBe(true);
    // Not flagged as broken, because feeding nothing is the point of it.
    expect(practice?.feedsNothing).toBe(false);
  });

  it('feeds no competition at all', async () => {
    const practice = (await rounds()).rounds.find((r) => r.name === 'Wednesday practice');
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM round_competitions WHERE round_id = $1',
      [practice?.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('takes a key the ruleset does not name, whatever the caller asks for', async () => {
    // Letting a caller choose would let them pick "thu-am", and the round would quietly
    // start counting towards the dogfight.
    await post('/api/rounds', {
      eventId,
      courseId,
      key: 'thu-am',
      name: 'Sneaky practice',
      isPractice: true,
      holeSelection: { mode: 'all' },
    });
    const sneaky = (await rounds()).rounds.find((r) => r.name === 'Sneaky practice');
    expect(sneaky?.key).not.toBe('thu-am');
    expect(sneaky?.key).toMatch(/^practice-/);
  });
});

describe('what it does to the scoring', () => {
  it('nothing — the standings do not see it', async () => {
    const practice = (await rounds()).rounds.find((r) => r.name === 'Wednesday practice');

    // Score it as if everyone played, which on a practice day they did.
    const roster = (await (
      await harness.request(`/api/events/${eventId}/players`, { cookies })
    ).json()) as { players: { personId: string }[] };
    await post(`/api/rounds/${practice?.id}/totals`, {
      totals: roster.players.map((player) => ({ personId: player.personId, pointsPulled: 44 })),
    });

    const standings = (await (
      await harness.request(`/api/events/${eventId}/standings`, { cookies })
    ).json()) as { rounds?: { key: string }[]; players?: { runningTotal: number }[] };

    // The round is not among the ones the standings are built from.
    expect((standings.rounds ?? []).some((r) => r.key.startsWith('practice-'))).toBe(false);
    // And nobody's standing moved, despite 44 points being recorded against them.
    expect((standings.players ?? []).every((p) => p.runningTotal === 0)).toBe(true);
  });

  it('and nobody is disqualified for a round that never counted', async () => {
    const standings = (await (
      await harness.request(`/api/events/${eventId}/standings`, { cookies })
    ).json()) as { players?: { disqualified: boolean }[] };
    expect((standings.players ?? []).every((p) => !p.disqualified)).toBe(true);
  });
});

describe('a round that counts is untouched', () => {
  it('still feeds its competitions', async () => {
    await post('/api/rounds', {
      eventId,
      courseId,
      key: 'thu-am',
      name: 'Thursday morning',
      holeSelection: { mode: 'all' },
    });
    const real = (await rounds()).rounds.find((r) => r.key === 'thu-am');
    expect(real?.isPractice).toBe(false);
    expect(real?.feedsNothing).toBe(false);

    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM round_competitions WHERE round_id = $1',
      [real?.id],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});
