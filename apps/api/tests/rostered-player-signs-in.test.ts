import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;

/**
 * A player who was put on the roster, then made an account.
 *
 * This is the path that has to be effortless: somebody's group admin adds them, they get an
 * email, they set a password, and they are in. No code to read out, no step where an
 * unfamiliar word decides whether it works. Whatever else exists, this must.
 */
let harness: AuthHarness;
let adminCookies = '';
let orgId = '';
let eventId = '';

const PASSWORD = 'correct-horse-battery';

function post(path: string, body: unknown, cookies: string) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

/** Sign up and verify, as a player following a link from their email. */
async function makeAccount(email: string, name: string): Promise<string> {
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
  return cookiesFrom(
    await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
}

async function me(cookies: string) {
  return (await (await harness.request('/api/me', { cookies })).json()) as {
    displayName: string;
    groups: { orgId: string; name: string; role: string }[];
    events: { eventId: string; eventName: string; roles: string[] }[];
  };
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_rostered');
  adminCookies = await makeAccount('admin@example.com', 'The Admin');
  orgId = ((await (
    await post('/api/organizations', { name: 'Divot Diggers' }, adminCookies)
  ).json()) as { id: string }).id;
  await post('/api/rulesets', RULESET, adminCookies);
  eventId = ((await (
    await post('/api/events', { name: 'DDD 2027', year: 2027 }, adminCookies)
  ).json()) as { id: string }).id;

  // The admin builds the roster from a spreadsheet, as they would in the console.
  await post(
    `/api/events/${eventId}/roster/import`,
    {
      rows: [
        { name: 'Levi Livermont', email: 'levi@example.com', startingPtp: 16 },
        { name: 'Elliot Griffiths', email: 'elliot@example.com', startingPtp: 38 },
        { name: 'No Address', startingPtp: 30 },
      ],
    },
    adminCookies,
  );
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('being put on the roster', () => {
  it('makes somebody a member of the group before they have an account at all', async () => {
    const { rows } = await harness.privilegedPool.query<{ role: string; email: string }>(
      `SELECT m.role, p.email FROM org_members m JOIN people p ON p.id = m.person_id
        WHERE m.org_id = $1 AND p.email = $2`,
      [orgId, 'levi@example.com'],
    );
    expect(rows[0]?.role).toBe('member');
  });

  it('and puts them on the roster with the target the admin set', async () => {
    const { rows } = await harness.privilegedPool.query<{ starting_ptp: string }>(
      `SELECT ep.starting_ptp FROM event_players ep JOIN people p ON p.id = ep.person_id
        WHERE ep.event_id = $1 AND p.email = $2`,
      [eventId, 'levi@example.com'],
    );
    expect(Number(rows[0]?.starting_ptp)).toBe(16);
  });
});

describe('then signing up with that address', () => {
  it('drops them straight into their group, with no code anywhere', async () => {
    const levi = await makeAccount('levi@example.com', 'Levi Livermont');
    const summary = await me(levi);

    expect(summary.groups).toEqual([{ orgId, name: 'Divot Diggers', role: 'member' }]);
  });

  it('claims the person the admin created rather than making a second one', async () => {
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM people WHERE lower(email) = $1',
      ['levi@example.com'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('keeps the roster entry and its target attached to them', async () => {
    const { rows } = await harness.privilegedPool.query<{ starting_ptp: string }>(
      `SELECT ep.starting_ptp FROM event_players ep
         JOIN people p ON p.id = ep.person_id
        WHERE ep.event_id = $1 AND p.auth_user_id IS NOT NULL AND p.email = $2`,
      [eventId, 'levi@example.com'],
    );
    expect(Number(rows[0]?.starting_ptp)).toBe(16);
  });
});

describe('inviting the roster', () => {
  it('emails everyone who has an address, and names who does not', async () => {
    const response = await post(`/api/events/${eventId}/roster/invite`, {}, adminCookies);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { sent: string[]; withoutEmail: string[] };
    expect(body.sent).toEqual(expect.arrayContaining(['Levi Livermont', 'Elliot Griffiths']));
    // Named rather than counted, so an admin knows who to chase for an address.
    expect(body.withoutEmail).toEqual(['No Address']);
  });

  it('sends a set-a-password link with the address already in it', async () => {
    const email = harness.mailer.lastTo('elliot@example.com');
    expect(email?.subject).toContain('DDD 2027');
    const link = linkFrom(email?.text ?? '');
    expect(link).toContain('/sign-up');
    expect(new URL(link).searchParams.get('email')).toBe('elliot@example.com');
  });

  it('sends somebody who already has an account to sign in instead', async () => {
    // Levi signed up earlier in this file, so a password link would be the wrong advice.
    await post(`/api/events/${eventId}/roster/invite`, {}, adminCookies);
    const link = linkFrom(harness.mailer.lastTo('levi@example.com')?.text ?? '');
    expect(link).toContain('/sign-in');
  });

  it('can invite one player on their own', async () => {
    const { rows } = await harness.privilegedPool.query<{ person_id: string }>(
      `SELECT ep.person_id FROM event_players ep JOIN people p ON p.id = ep.person_id
        WHERE ep.event_id = $1 AND p.email = $2`,
      [eventId, 'elliot@example.com'],
    );
    const response = await post(
      `/api/events/${eventId}/roster/invite/${rows[0]?.person_id}`,
      {},
      adminCookies,
    );
    expect((await response.json()) as { sent: string[] }).toEqual({
      sent: ['Elliot Griffiths'],
      withoutEmail: [],
    });
  });

  it('refuses somebody who does not administer the event', async () => {
    const levi = await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'levi@example.com', password: PASSWORD }),
    });
    const response = await post(
      `/api/events/${eventId}/roster/invite`,
      {},
      cookiesFrom(levi),
    );
    expect(response.status).toBe(403);
  });
});

describe('somebody who was never rostered', () => {
  it('belongs nowhere, and is the only person a join code is for', async () => {
    const stranger = await makeAccount('stranger@example.com', 'A Stranger');
    const summary = await me(stranger);
    expect(summary.groups).toEqual([]);
    expect(summary.events).toEqual([]);
  });
});

describe('ADVERSARIAL: the roster is not a way in', () => {
  it('gives nothing to somebody signing up with an address that is merely similar', async () => {
    const nearly = await makeAccount('levi@example.com.evil.test', 'Not Levi');
    expect((await me(nearly)).groups).toEqual([]);
  });

  it('does not link a rostered person until the address is actually verified', async () => {
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email: 'elliot@example.com',
        password: PASSWORD,
        name: 'Someone Claiming To Be Elliot',
      }),
    });
    // Signed up but never followed the link, so the claim has not happened.
    const { rows } = await harness.privilegedPool.query<{ auth_user_id: string | null }>(
      'SELECT auth_user_id FROM people WHERE lower(email) = $1',
      ['elliot@example.com'],
    );
    expect(rows[0]?.auth_user_id).toBeNull();
  });
});

describe('an event has dates and can be edited', () => {
  it('takes dates when it is created', async () => {
    const created = await post(
      '/api/events',
      { name: 'DDD 2028', year: 2028, startDate: '2028-08-10', endDate: '2028-08-13' },
      adminCookies,
    );
    const id = ((await created.json()) as { id: string }).id;

    const detail = (await (
      await harness.request(`/api/events/${id}/detail`, { cookies: adminCookies })
    ).json()) as { startDate: string; endDate: string; name: string; mayEdit: boolean };

    // Dates, not timestamps: a trip starts on a day, and a timezone must never shift it.
    expect(detail.startDate).toBe('2028-08-10');
    expect(detail.endDate).toBe('2028-08-13');
    expect(detail.mayEdit).toBe(true);
  });

  it('refuses an event that ends before it starts', async () => {
    const response = await post(
      '/api/events',
      { name: 'Backwards', year: 2029, startDate: '2029-08-13', endDate: '2029-08-10' },
      adminCookies,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/cannot end before/i);
  });

  it('lets an admin change the name and the dates afterwards', async () => {
    const created = await post('/api/events', { name: 'Needs A Rename', year: 2030 }, adminCookies);
    const id = ((await created.json()) as { id: string }).id;

    await post(
      `/api/events/${id}/detail`,
      { name: 'Renamed Properly', startDate: '2030-09-01', endDate: '2030-09-04' },
      adminCookies,
    );

    const detail = (await (
      await harness.request(`/api/events/${id}/detail`, { cookies: adminCookies })
    ).json()) as { name: string; startDate: string };
    expect(detail.name).toBe('Renamed Properly');
    expect(detail.startDate).toBe('2030-09-01');
  });

  it('reports what is still missing, so the page can say what to do next', async () => {
    const detail = (await (
      await harness.request(`/api/events/${eventId}/detail`, { cookies: adminCookies })
    ).json()) as { playerCount: number; roundCount: number; courseCount: number };
    expect(detail.playerCount).toBe(3);
    expect(detail.roundCount).toBe(0);
    expect(detail.courseCount).toBe(0);
  });

  it('will not let a player edit somebody else\'s event', async () => {
    const levi = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'levi@example.com', password: PASSWORD }),
      }),
    );
    const response = await post(`/api/events/${eventId}/detail`, { name: 'Hijacked' }, levi);
    expect(response.status).toBe(403);
  });
});
