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
 * Changing a round after it exists.
 *
 * Rounds were write-once: a typo in a name, the wrong course from a dropdown, a date a day
 * out — all permanent. The interesting half is what must *not* change once somebody has been
 * scored, because pars and stroke indexes are what turn strokes into points.
 */
let harness: AuthHarness;
let cookies = '';
let eventId = '';
let courseId = '';
let otherCourseId = '';

const PASSWORD = 'correct-horse-battery';

function post(path: string, body: unknown, as = cookies) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies: as });
}

// Rounds are unique per (event, key), so every one of these needs its own.
let nextKey = 0;

async function makeRound(extra: Record<string, unknown> = {}): Promise<string> {
  nextKey += 1;
  const response = await post('/api/rounds', {
    eventId,
    courseId,
    name: 'Thursday morning',
    key: `round-${nextKey}`,
    ...extra,
  });
  const text = await response.text();
  if (response.status !== 201) throw new Error(`could not create a round: ${text}`);
  return (JSON.parse(text) as { id: string }).id;
}

async function readRound(id: string) {
  return (await (await harness.request(`/api/rounds/${id}`, { cookies })).json()) as {
    name: string;
    playedOn: string | null;
    isPractice: boolean;
    course: string | null;
    resolved: { holes: unknown[] } | null;
  };
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_editround');
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

  courseId = ((await (await post('/api/courses', COURSE)).json()) as { id: string }).id;
  const second = JSON.parse(JSON.stringify(COURSE)) as { course: { name: string } };
  second.course.name = 'Somewhere Else';
  otherCourseId = ((await (await post('/api/courses', second)).json()) as { id: string }).id;

  await post(`/api/events/${eventId}/roster/import`, {
    rows: [{ name: 'Levi Livermont', startingPtp: 16 }],
  });
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('correcting a round nobody has played yet', () => {
  it('fixes a typo in the name', async () => {
    const id = await makeRound({ name: 'Thursady morning' });
    expect((await post(`/api/rounds/${id}`, { name: 'Thursday morning' })).status).toBe(200);
    expect((await readRound(id)).name).toBe('Thursday morning');
  });

  it('moves it to a different day', async () => {
    const id = await makeRound({ playedOn: '2027-08-12' });
    await post(`/api/rounds/${id}`, { playedOn: '2027-08-13' });
    expect((await readRound(id)).playedOn).toBe('2027-08-13');
  });

  it('changes the course, and takes a tee set from the new one', async () => {
    const id = await makeRound();
    expect((await post(`/api/rounds/${id}`, { courseId: otherCourseId })).status).toBe(200);

    const after = await readRound(id);
    expect(after.course).toBe('Somewhere Else');
    // The old course's tee set must not survive the move, or the round would be scored
    // against holes it is not playing.
    const { rows } = await harness.privilegedPool.query<{ course_id: string }>(
      `SELECT t.course_id FROM rounds r JOIN tee_sets t ON t.id = r.tee_set_id WHERE r.id = $1`,
      [id],
    );
    expect(rows[0]?.course_id).toBe(otherCourseId);
  });

  it('changes the holes being played', async () => {
    const id = await makeRound();
    expect((await readRound(id)).resolved?.holes).toHaveLength(18);
    await post(`/api/rounds/${id}`, { holeSelection: { mode: 'front9' } });
    expect((await readRound(id)).resolved?.holes).toHaveLength(9);
  });

  it('turns a counting round into a practice round, and stops it counting', async () => {
    const id = await makeRound();
    const before = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM round_competitions WHERE round_id = $1',
      [id],
    );
    expect(Number(before.rows[0]?.count)).toBeGreaterThan(0);

    await post(`/api/rounds/${id}`, { isPractice: true });

    const after = await harness.privilegedPool.query<{ count: string; key: string }>(
      `SELECT (SELECT count(*) FROM round_competitions rc WHERE rc.round_id = r.id) AS count,
              r.key FROM rounds r WHERE r.id = $1`,
      [id],
    );
    expect(after.rows[0]?.count).toBe('0');
    // And renamed out of the ruleset's vocabulary, so the standings cannot pick it up.
    expect(after.rows[0]?.key).toMatch(/^practice-/);
  });

  it('turns a practice round back into one that counts', async () => {
    const id = await makeRound({ isPractice: true, name: 'Warm up' });
    await post(`/api/rounds/${id}`, { isPractice: false, key: 'fri-am' });

    const { rows } = await harness.privilegedPool.query<{ count: string; key: string }>(
      `SELECT (SELECT count(*) FROM round_competitions rc WHERE rc.round_id = r.id) AS count,
              r.key FROM rounds r WHERE r.id = $1`,
      [id],
    );
    expect(rows[0]?.key).toBe('fri-am');
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('refuses to un-practice a round without saying what it counts towards', async () => {
    const id = await makeRound({ isPractice: true, name: 'Warm up' });
    const response = await post(`/api/rounds/${id}`, { isPractice: false });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/which round of the rules/i);
  });

  it('refuses a hole selection the tee set cannot play', async () => {
    const id = await makeRound();
    const response = await post(`/api/rounds/${id}`, {
      holeSelection: { mode: 'custom', holes: [1, 2, 99] },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('once somebody has been scored', () => {
  let scoredRound = '';

  beforeAll(async () => {
    scoredRound = await makeRound({ name: 'Saturday morning' });
    const players = (await (
      await harness.request(`/api/events/${eventId}/players`, { cookies })
    ).json()) as { players: { personId: string }[] };
    await post(`/api/rounds/${scoredRound}/totals`, {
      totals: [{ personId: players.players[0]?.personId, pointsPulled: 41 }],
    });
  });

  it('still lets the name be corrected', async () => {
    expect((await post(`/api/rounds/${scoredRound}`, { name: 'Saturday AM' })).status).toBe(200);
    expect((await readRound(scoredRound)).name).toBe('Saturday AM');
  });

  it('still lets the date be corrected', async () => {
    expect((await post(`/api/rounds/${scoredRound}`, { playedOn: '2027-08-14' })).status).toBe(200);
  });

  it('refuses to change the course under a card that has been scored', async () => {
    const response = await post(`/api/rounds/${scoredRound}`, { courseId: otherCourseId });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already shot/i);
  });

  it('refuses to change which holes were played', async () => {
    expect((await post(`/api/rounds/${scoredRound}`, { holeSelection: { mode: 'back9' } })).status).toBe(409);
  });

  it('refuses to make a scored round stop counting', async () => {
    expect((await post(`/api/rounds/${scoredRound}`, { isPractice: true })).status).toBe(409);
  });

  it('leaves the round exactly as it was after each refusal', async () => {
    const after = await readRound(scoredRound);
    expect(after.course).toBe('Caledonia Golf & Fish Club');
    expect(after.resolved?.holes).toHaveLength(18);
  });
});

describe('ADVERSARIAL: editing is for whoever runs the group', () => {
  it('refuses somebody with no business here', async () => {
    const id = await makeRound();
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'outsider@example.com', password: PASSWORD, name: 'Outsider' }),
    });
    const link = linkFrom(harness.mailer.lastTo('outsider@example.com')?.text ?? '');
    await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
    const theirs = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'outsider@example.com', password: PASSWORD }),
      }),
    );

    const response = await post(`/api/rounds/${id}`, { name: 'Mine now' }, theirs);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await readRound(id)).name).not.toBe('Mine now');
  });
});
