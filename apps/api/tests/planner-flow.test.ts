import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    expect(rows[0]?.status).toBe('in_progress');
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
