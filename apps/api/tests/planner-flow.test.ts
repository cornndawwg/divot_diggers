import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cookiesFrom,
  createAuthHarness,
  linkFrom,
  type AuthHarness,
} from './helpers/auth-harness.ts';

/**
 * The parking-lot path, end to end through the API: sign up, create a group, tap in a
 * nine-hole course, start a round on it. Plus the adversarial half — the write policies
 * added in migration 0005 must not let one group touch another's data.
 */

let harness: AuthHarness;
let cookies = '';
let otherCookies = '';

const PASSWORD = 'correct-horse-battery';

async function register(email: string, name: string): Promise<string> {
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  const path = link.slice(new URL(link).origin.length);
  await harness.request(path, { redirect: 'manual' });
  const signedIn = await harness.request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return cookiesFrom(signedIn);
}

function post(path: string, body: unknown, jar: string) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies: jar });
}

const NINE = [4, 3, 5, 4, 4, 3, 4, 5, 4];

const RULESET = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

beforeAll(async () => {
  harness = await createAuthHarness('ddga_planner');
  cookies = await register('planner@example.com', 'Justin Crumpler');
  otherCookies = await register('rival@example.com', 'Rival Planner');
}, 120_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('before there is a group', () => {
  it('shows no courses, because there is nothing to be in', async () => {
    const response = await harness.request('/api/courses', { cookies });
    expect(((await response.json()) as { courses: unknown[] }).courses).toEqual([]);
  });

  it('refuses to save a course and says why', async () => {
    const response = await post(
      '/api/courses',
      {
        course: { name: 'Nowhere', totalHoles: 9 },
        teeSets: [{ name: 'Default', holes: NINE.map((par, i) => ({ holeNumber: i + 1, par })) }],
      },
      cookies,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('Create your group first.');
  });
});

describe('the parking-lot path', () => {
  it('creates a group and makes the caller its owner', async () => {
    const response = await post('/api/organizations', { name: 'Divot Diggers' }, cookies);
    expect(response.status).toBe(201);

    // The membership has to exist too, or RLS would hide the group from its own creator.
    const listed = await harness.request('/api/organizations', { cookies });
    const body = (await listed.json()) as { organizations: { name: string; slug: string }[] };
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.name).toBe('Divot Diggers');
    expect(body.organizations[0]?.slug).toBe('divot-diggers');
  });

  it('saves a nine-hole course from pars alone', async () => {
    const response = await post(
      '/api/courses',
      {
        course: { name: 'Parking Lot Muni', totalHoles: 9, source: 'manual' },
        teeSets: [{ name: 'Default', holes: NINE.map((par, i) => ({ holeNumber: i + 1, par })) }],
      },
      cookies,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      holeCount: number;
      validation: { valid: boolean; errors: unknown[]; warnings: unknown[] };
    };
    expect(body.holeCount).toBe(9);
    // A par-only course must be clean, not merely accepted with complaints.
    expect(body.validation.valid).toBe(true);
    expect(body.validation.errors).toEqual([]);
    expect(body.validation.warnings).toEqual([]);
  });

  it('lists it as playable, flagged as pars only', async () => {
    const response = await harness.request('/api/courses', { cookies });
    const body = (await response.json()) as {
      courses: { name: string; totalHoles: number; completeness: string }[];
    };
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0]).toMatchObject({
      name: 'Parking Lot Muni',
      totalHoles: 9,
      completeness: 'par_only',
    });
  });

  it('starts a round on it', async () => {
    const event = await post('/api/events', { name: 'Casual play', year: 2027 }, cookies);
    expect(event.status).toBe(201);
    const eventId = ((await event.json()) as { id: string }).id;

    const courses = await harness.request('/api/courses', { cookies });
    const courseId = ((await courses.json()) as { courses: { id: string }[] }).courses[0]?.id ?? '';

    const round = await post(
      '/api/rounds',
      { eventId, courseId, name: 'Parking Lot Muni', holeSelection: { mode: 'front9' } },
      cookies,
    );
    expect(round.status).toBe(201);
    expect((await round.json()) as { key: string }).toMatchObject({ key: 'round-1' });
  });

  it('records the round against the course and tee set', async () => {
    const { rows } = await harness.privilegedPool.query<{
      status: string;
      hole_selection: { mode: string };
      course_name: string;
      tee_set: string;
    }>(
      `SELECT r.status, r.hole_selection, c.name AS course_name, t.name AS tee_set
         FROM rounds r JOIN courses c ON c.id = r.course_id
         JOIN tee_sets t ON t.id = r.tee_set_id`,
    );
    expect(rows[0]?.course_name).toBe('Parking Lot Muni');
    expect(rows[0]?.tee_set).toBe('Default');
    expect(rows[0]?.hole_selection.mode).toBe('front9');
    // Scheduled, not in progress: a round on the sheet has not been played yet, and the
    // difference is what lets a planner set one up weeks ahead.
    expect(rows[0]?.status).toBe('scheduled');
  });

  it('rejects a course whose pars contradict a printed total', async () => {
    const response = await post(
      '/api/courses',
      {
        course: { name: 'Bad Card', totalHoles: 9 },
        teeSets: [
          {
            name: 'Default',
            parTotal: 36,
            holes: [4, 3, 5, 4, 4, 3, 4, 5, 5].map((par, i) => ({ holeNumber: i + 1, par })),
          },
        ],
      },
      cookies,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { validation: { errors: { id: string }[] } };
    expect(body.validation.errors.map((error) => error.id)).toContain('par_totals');
  });

  it('wrote nothing for the rejected card', async () => {
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM courses WHERE name = 'Bad Card'`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('ADVERSARIAL: the new write policies', () => {
  it('gives a second planner their own group, not the first one', async () => {
    await post('/api/organizations', { name: 'Rival Society' }, otherCookies);
    const response = await harness.request('/api/organizations', { cookies: otherCookies });
    const body = (await response.json()) as { organizations: { name: string }[] };
    expect(body.organizations.map((org) => org.name)).toEqual(['Rival Society']);
  });

  it('hides the first group’s courses from the second planner', async () => {
    const response = await harness.request('/api/courses', { cookies: otherCookies });
    expect(((await response.json()) as { courses: unknown[] }).courses).toEqual([]);
  });

  it('hides the first group’s events and rounds', async () => {
    const response = await harness.request('/api/events', { cookies: otherCookies });
    expect(((await response.json()) as { events: unknown[] }).events).toEqual([]);
  });

  it('refuses to start a round on another group’s event', async () => {
    const events = await harness.privilegedPool.query<{ id: string }>(
      `SELECT e.id FROM events e JOIN organizations o ON o.id = e.org_id WHERE o.slug = 'divot-diggers'`,
    );
    const courses = await harness.privilegedPool.query<{ id: string }>(
      `SELECT id FROM courses WHERE name = 'Parking Lot Muni'`,
    );
    const response = await post(
      '/api/rounds',
      { eventId: events.rows[0]?.id, courseId: courses.rows[0]?.id },
      otherCookies,
    );
    // 403, not 500: the policy refused it, which is an answer rather than a fault.
    expect(response.status).toBe(403);

    const rounds = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM rounds',
    );
    // Still just the one legitimate round.
    expect(rounds.rows[0]?.count).toBe('1');
  });

  it('refuses to create an event in a group it does not belong to', async () => {
    const orgs = await harness.privilegedPool.query<{ id: string }>(
      `SELECT id FROM organizations WHERE slug = 'divot-diggers'`,
    );
    const response = await post(
      '/api/events',
      { organizationId: orgs.rows[0]?.id, name: 'Hijack', year: 2027 },
      otherCookies,
    );
    expect(response.status).toBe(403);

    const events = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM events WHERE name = 'Hijack'`,
    );
    expect(events.rows[0]?.count).toBe('0');
  });

  it('cannot write a course into the shared library', async () => {
    // org_id NULL is the cross-tenant library. The policy requires org_id IS NOT NULL.
    await expect(
      harness.domainPool.query(
        `INSERT INTO courses (org_id, name, total_holes) VALUES (NULL, 'Sneaky', 18)`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('BUILD-TASKS 2.5: two rounds on the same course', () => {
  // An 18-hole dogfight round and a 9-hole Cup round, on one course. Each has to report
  // its own hole count and par total.
  let courseId = '';
  let eventId = '';

  beforeAll(async () => {
    const seed = JSON.parse(
      (await import('node:fs')).readFileSync(
        (await import('node:url')).fileURLToPath(
          new URL('../../../seed/caledonia.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as unknown;

    const created = await post('/api/courses', seed, cookies);
    expect(created.status).toBe(201);
    courseId = ((await created.json()) as { id: string }).id;

    const events = await harness.request('/api/events', { cookies });
    eventId = ((await events.json()) as { events: { id: string }[] }).events[0]?.id ?? '';
  });

  async function makeRound(name: string, holeSelection: unknown): Promise<string> {
    const response = await post('/api/rounds', { eventId, courseId, name, holeSelection }, cookies);
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function readRound(id: string) {
    const response = await harness.request(`/api/rounds/${id}`, { cookies });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      name: string;
      course: string;
      teeSet: string;
      resolved: { holeCount: number; parTotal: number; outPar: number | null; inPar: number | null };
    };
  }

  it('reports 18 holes and par 70 for the dogfight round', async () => {
    const id = await makeRound('Thursday AM dogfight', { mode: 'all' });
    const round = await readRound(id);
    expect(round.course).toBe('Caledonia Golf & Fish Club');
    expect(round.teeSet).toBe('Pintail'); // the longest tee set, chosen by default
    expect(round.resolved.holeCount).toBe(18);
    expect(round.resolved.parTotal).toBe(70);
    expect([round.resolved.outPar, round.resolved.inPar]).toEqual([35, 35]);
  });

  it('reports 9 holes and par 35 for the Cup round on the same course', async () => {
    const id = await makeRound('Thursday PM Cup', { mode: 'front9' });
    const round = await readRound(id);
    expect(round.course).toBe('Caledonia Golf & Fish Club');
    expect(round.resolved.holeCount).toBe(9);
    expect(round.resolved.parTotal).toBe(35);
    expect(round.resolved.inPar).toBeNull();
  });

  it('keeps both rounds on the one event, each with its own selection', async () => {
    const events = await harness.request('/api/events', { cookies });
    const body = (await events.json()) as { events: { id: string; rounds: number }[] };
    const event = body.events.find((entry) => entry.id === eventId);
    // The casual round from the earlier test, plus these two.
    expect(event?.rounds).toBeGreaterThanOrEqual(3);
  });

  it('refuses a round whose selection cannot be played', async () => {
    const response = await post(
      '/api/rounds',
      { eventId, courseId, name: 'Nonsense', holeSelection: { mode: 'custom', holes: [19, 20] } },
      cookies,
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/not on the Pintail tees/);
  });

  it('refuses a malformed selection before it reaches the database', async () => {
    const response = await post(
      '/api/rounds',
      { eventId, courseId, holeSelection: { mode: 'front-nine' } },
      cookies,
    );
    expect(response.status).toBe(400);
  });

  it('wrote no round for either rejection', async () => {
    const { rows } = await harness.privilegedPool.query<{ name: string }>(
      'SELECT name FROM rounds WHERE event_id = $1 ORDER BY sequence',
      [eventId],
    );
    // Only the rounds that were accepted. Nothing named Nonsense, and nothing from the
    // malformed request either.
    expect(rows.map((row) => row.name)).toEqual([
      'Parking Lot Muni',
      'Thursday AM dogfight',
      'Thursday PM Cup',
    ]);
  });
});

describe('a brand new group can be used immediately', () => {
  // The bug this guards: a group started with no rules, so there was no target to seed and
  // adding the very first person to a roster failed with "no dogfight competition
  // configured" — on the first thing a new planner tries to do.
  let freshCookies = '';
  let freshEventId = '';

  beforeAll(async () => {
    const email = 'brandnew@example.com';
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD, name: 'Brand New' }),
    });
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
    freshCookies = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    await post('/api/organizations', { name: 'Brand New Society' }, freshCookies);
  });

  it('starts with a set of rules of its own', async () => {
    const response = await harness.request('/api/rulesets', { cookies: freshCookies });
    const body = (await response.json()) as { rulesets: { name: string; version: number }[] };
    expect(body.rulesets).toHaveLength(1);
    expect(body.rulesets[0]?.name).toBe('Brand New Society House Rules');
    expect(body.rulesets[0]?.version).toBe(1);
  });

  it('seeds a target for the first player added, rather than failing', async () => {
    const event = await post('/api/events', { name: 'First Trip', year: 2027 }, freshCookies);
    freshEventId = ((await event.json()) as { id: string }).id;

    const person = await post('/api/people', { name: 'The Owner' }, freshCookies);
    const personId = ((await person.json()) as { id: string }).id;

    const added = await post(
      `/api/events/${freshEventId}/players`,
      { personId, handicapIndex: 12, source: 'seeded_from_handicap' },
      freshCookies,
    );
    expect(added.status).toBe(201);
    const body = (await added.json()) as { startingTarget: { value: number; explanation: string } };
    // The starter subtracts from 36, not from 54: it is a neutral default, not another
    // group's house rules.
    expect(body.startingTarget.value).toBe(24);
    expect(body.startingTarget.explanation).toMatch(/36 − 12 = 24/);
  });

  it('adopts an event that was created before any rules existed', async () => {
    // Orphan the event, as it would have been before the fix.
    await harness.privilegedPool.query('UPDATE events SET ruleset_id = NULL WHERE id = $1', [
      freshEventId,
    ]);
    const response = await post('/api/rulesets', RULESET, freshCookies);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { attachedToEvents: number }).attachedToEvents).toBe(1);

    const { rows } = await harness.privilegedPool.query<{ ruleset_id: string | null }>(
      'SELECT ruleset_id FROM events WHERE id = $1',
      [freshEventId],
    );
    expect(rows[0]?.ruleset_id).not.toBeNull();
  });
});
