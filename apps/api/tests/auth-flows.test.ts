import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMigrations } from 'better-auth/db/migration';
import {
  cookiesFrom,
  createAuthHarness,
  linkFrom,
  type AuthHarness,
} from './helpers/auth-harness.ts';

/**
 * The four flows task 2.3 asks for — sign up, verify by email, sign in, reset a forgotten
 * password — driven end to end against a real database, with email captured instead of sent.
 * The browser check confirms the same paths through a UI.
 */

let harness: AuthHarness;

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-different-long-password';

beforeAll(async () => {
  harness = await createAuthHarness('ddga_auth');
}, 90_000);

afterAll(async () => {
  await harness?.destroy();
});

async function signUp(email: string, name = 'Test Golfer', password = PASSWORD) {
  return harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
}

async function signIn(email: string, password = PASSWORD) {
  return harness.request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/** Follow a link out of an email, the way clicking it would. */
async function visit(url: string) {
  const path = url.slice(new URL(url).origin.length);
  return harness.request(path, { redirect: 'manual' });
}

describe('the schema Better Auth expects', () => {
  it('is fully satisfied by migration 0004, with nothing left to create', async () => {
    // If Better Auth wants to create or alter anything, my hand-written 0004 has drifted
    // from what the library needs.
    const { toBeCreated, toBeAdded } = await getMigrations(harness.auth.options);
    expect(toBeCreated.map((entry) => entry.table)).toEqual([]);
    expect(toBeAdded.map((entry) => entry.table)).toEqual([]);
  });
});

describe('signing up', () => {
  const email = 'signup@example.com';

  it('accepts the registration', async () => {
    const response = await signUp(email, 'Justin Crumpler');
    expect(response.status).toBe(200);
  });

  it('sends exactly one verification email', async () => {
    const sent = harness.mailer.sent.filter((mail) => mail.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Confirm your email address');
  });

  it('creates the golfer profile linked to the credential', async () => {
    const { rows } = await harness.privilegedPool.query<{
      display_name: string;
      email: string;
      auth_user_id: string;
    }>('SELECT display_name, email, auth_user_id FROM people WHERE email = $1', [email]);
    expect(rows[0]?.display_name).toBe('Justin Crumpler');
    expect(rows[0]?.auth_user_id).toBeTruthy();

    const linked = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM "user" u JOIN people p ON p.auth_user_id = u.id WHERE u.email = $1',
      [email],
    );
    expect(linked.rows[0]?.count).toBe('1');
  });

  it('refuses to sign in before the address is verified', async () => {
    const response = await signIn(email);
    expect(response.status).toBe(403);
  });

  it('creates no second account for an address already registered', async () => {
    // Better Auth answers 200 rather than "that email is taken", so an attacker cannot
    // enumerate who has an account. What must hold is that nothing was duplicated.
    const response = await signUp(email);
    expect(response.status).toBe(200);

    const users = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM "user" WHERE email = $1',
      [email],
    );
    expect(users.rows[0]?.count).toBe('1');

    const people = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM people WHERE email = $1',
      [email],
    );
    expect(people.rows[0]?.count).toBe('1');
  });

  it('refuses a password under ten characters', async () => {
    const response = await signUp('shortpw@example.com', 'Short', 'short');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('never stores the password in readable form', async () => {
    const { rows } = await harness.privilegedPool.query<{ password: string }>(
      `SELECT a.password FROM account a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1`,
      [email],
    );
    const stored = rows[0]?.password ?? '';
    expect(stored).not.toContain(PASSWORD);
    expect(stored.length).toBeGreaterThan(30);
  });
});

describe('verifying by email', () => {
  const email = 'verify@example.com';

  beforeAll(async () => {
    await signUp(email, 'Casey Wheeler');
  });

  it('starts unverified', async () => {
    const { rows } = await harness.privilegedPool.query<{ emailVerified: boolean }>(
      'SELECT "emailVerified" FROM "user" WHERE email = $1',
      [email],
    );
    expect(rows[0]?.emailVerified).toBe(false);
  });

  it('marks the address verified when the emailed link is followed', async () => {
    const mail = harness.mailer.lastTo(email);
    expect(mail).toBeDefined();
    const response = await visit(linkFrom(mail?.text ?? ''));
    expect([200, 302]).toContain(response.status);

    const { rows } = await harness.privilegedPool.query<{ emailVerified: boolean }>(
      'SELECT "emailVerified" FROM "user" WHERE email = $1',
      [email],
    );
    expect(rows[0]?.emailVerified).toBe(true);
  });

  it('then allows sign in', async () => {
    const response = await signIn(email);
    expect(response.status).toBe(200);
    expect(cookiesFrom(response)).toContain('session_token');
  });

  it('sends the golfer to the console afterwards, not to the API', async () => {
    // The default callbackURL is "/", which would land them on the API, which serves no
    // pages at all.
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    expect(new URL(link).searchParams.get('callbackURL')).toBe('http://localhost:3000/verified');
  });

  it('puts the same link in the HTML part as the text part', async () => {
    const mail = harness.mailer.lastTo(email);
    expect(mail?.html).toContain(linkFrom(mail?.text ?? ''));
  });
});

describe('a signed-in session', () => {
  const email = 'session@example.com';
  let cookies = '';

  beforeAll(async () => {
    await signUp(email, 'Peter Marshall');
    await visit(linkFrom(harness.mailer.lastTo(email)?.text ?? ''));
    cookies = cookiesFrom(await signIn(email));
  });

  it('identifies the golfer', async () => {
    const response = await harness.request('/api/me', { cookies });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { displayName: string; email: string; events: unknown[] };
    expect(body.displayName).toBe('Peter Marshall');
    expect(body.email).toBe(email);
    expect(body.events).toEqual([]);
  });

  it('is refused without a cookie', async () => {
    const response = await harness.request('/api/me');
    expect(response.status).toBe(401);
  });

  it('is refused with a forged cookie', async () => {
    const response = await harness.request('/api/me', {
      cookies: 'better-auth.session_token=not-a-real-token',
    });
    expect(response.status).toBe(401);
  });

  it('reports every role a person holds in an event', async () => {
    const person = await harness.privilegedPool.query<{ id: string }>(
      'SELECT id FROM people WHERE email = $1',
      [email],
    );
    const personId = person.rows[0]?.id ?? '';

    const org = await harness.privilegedPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ('Divot Diggers','ddd') RETURNING id`,
    );
    const orgId = org.rows[0]?.id ?? '';
    await harness.privilegedPool.query(
      `INSERT INTO org_members (org_id, person_id, role) VALUES ($1,$2,'owner')`,
      [orgId, personId],
    );
    const event = await harness.privilegedPool.query<{ id: string }>(
      `INSERT INTO events (org_id, name, year, status) VALUES ($1,'DDD 2027',2027,'draft') RETURNING id`,
      [orgId],
    );
    const eventId = event.rows[0]?.id ?? '';
    // One person, three roles in the same event.
    await harness.privilegedPool.query(
      `INSERT INTO event_roles (event_id, person_id, role)
       VALUES ($1,$2,'planner'), ($1,$2,'captain'), ($1,$2,'player')`,
      [eventId, personId],
    );

    const response = await harness.request('/api/me', { cookies });
    const body = (await response.json()) as {
      events: { eventName: string; roles: string[] }[];
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventName).toBe('DDD 2027');
    expect(body.events[0]?.roles).toEqual(['captain', 'planner', 'player']);
  });

  it('signs out', async () => {
    const out = await harness.request('/api/auth/sign-out', { method: 'POST', cookies });
    expect(out.status).toBe(200);
    const after = await harness.request('/api/me', { cookies });
    expect(after.status).toBe(401);
  });
});

describe('resetting a forgotten password', () => {
  const email = 'reset@example.com';
  let resetToken = '';

  beforeAll(async () => {
    await signUp(email, 'Kenny Adkins');
    await visit(linkFrom(harness.mailer.lastTo(email)?.text ?? ''));
    harness.mailer.clear();
  });

  async function requestReset(address: string) {
    return harness.request('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: address, redirectTo: 'http://localhost:3000/reset-password' }),
    });
  }

  it('emails a reset link', async () => {
    const response = await requestReset(email);
    expect(response.status).toBe(200);
    const mail = harness.mailer.lastTo(email);
    expect(mail?.subject).toBe('Reset your password');
    expect(mail?.text).toMatch(/expires in one hour/i);
  });

  it('bounces the emailed link through the API to the console, carrying the token', async () => {
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    // The email links to the API, not the console, so a token can be rejected before the
    // browser ever renders a password form.
    expect(link).toContain('/api/auth/reset-password/');

    const redirect = await visit(link);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get('location') ?? '';
    expect(location).toContain('http://localhost:3000/reset-password');
    expect(new URL(location).searchParams.get('token')).toBeTruthy();
  });

  it('sets the new password when the token is submitted', async () => {
    const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
    const location = (await visit(link)).headers.get('location') ?? '';
    resetToken = new URL(location).searchParams.get('token') ?? '';
    expect(resetToken).toBeTruthy();

    const response = await harness.request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword: NEW_PASSWORD, token: resetToken }),
    });
    expect(response.status).toBe(200);
  });

  it('signs in with the new password', async () => {
    const response = await signIn(email, NEW_PASSWORD);
    expect(response.status).toBe(200);
  });

  it('refuses the old password', async () => {
    const response = await signIn(email, PASSWORD);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to reuse the same reset token', async () => {
    expect(resetToken).toBeTruthy();
    const response = await harness.request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'yet-another-long-password', token: resetToken }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('says nothing about whether an unknown address has an account', async () => {
    harness.mailer.clear();
    const response = await requestReset('nobody@example.com');
    // Same 200 as a known address: the response must not confirm who is registered.
    expect(response.status).toBe(200);
    expect(harness.mailer.lastTo('nobody@example.com')).toBeUndefined();
  });
});

describe('the credential tables are unreachable from the app connection', () => {
  it('is granted SELECT on them, so RLS is what has to stop it', async () => {
    const { rows } = await harness.domainPool.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.table_privileges
       WHERE grantee = current_user AND privilege_type = 'SELECT'
         AND table_name IN ('user','session','account','verification')`,
    );
    expect(Number(rows[0]?.count)).toBe(4);
  });

  it('reads zero password hashes', async () => {
    const asOwner = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM account WHERE password IS NOT NULL',
    );
    expect(Number(asOwner.rows[0]?.count)).toBeGreaterThan(0);

    const asApp = await harness.domainPool.query<{ count: string }>('SELECT count(*) FROM account');
    expect(asApp.rows[0]?.count).toBe('0');
  });

  it('reads zero session tokens', async () => {
    const asApp = await harness.domainPool.query<{ count: string }>('SELECT count(*) FROM session');
    expect(asApp.rows[0]?.count).toBe('0');
  });

  it('reads zero credential records or verification tokens', async () => {
    for (const table of ['user', 'verification']) {
      const { rows } = await harness.domainPool.query<{ count: string }>(
        `SELECT count(*) FROM "${table}"`,
      );
      expect(rows[0]?.count, table).toBe('0');
    }
  });
});
