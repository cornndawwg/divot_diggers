import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;

/**
 * Joining an event with a six-character code — the phone app's way in.
 *
 * The code is deliberately weak enough to type on a first tee, so everything that makes that
 * acceptable is tested here: it expires, it can be withdrawn, it grants only playing
 * membership, and it belongs to exactly one event.
 */
let harness: AuthHarness;
let adminCookies = '';
let eventId = '';
let orgId = '';

const PASSWORD = 'correct-horse-battery';

async function signUp(email: string, name: string): Promise<string> {
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

function post(path: string, body: unknown, cookies: string) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

async function issueCode(days = 30): Promise<string> {
  const response = await post(`/api/events/${eventId}/join-code`, { days }, adminCookies);
  return ((await response.json()) as { code: string }).code;
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_joincode');
  adminCookies = await signUp('admin@example.com', 'The Admin');
  orgId = ((await (
    await post('/api/organizations', { name: 'Divot Diggers' }, adminCookies)
  ).json()) as { id: string }).id;
  await post('/api/rulesets', RULESET, adminCookies);
  eventId = ((await (
    await post('/api/events', { name: 'DDD 2027', year: 2027 }, adminCookies)
  ).json()) as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('the code itself', () => {
  it('is six characters a person can read off a screen', async () => {
    const code = await issueCode();
    expect(code).toHaveLength(6);
    // No O, 0, I or 1 — the pairs that get misread standing on a first tee.
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('is different every time it is rolled, and the old one stops working', async () => {
    const first = await issueCode();
    const second = await issueCode();
    expect(second).not.toBe(first);

    const player = await signUp('rolled@example.com', 'Too Slow');
    const response = await post('/api/join', { code: first }, player);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/does not match/i);
  });

  it('is shown back to the console with when it runs out', async () => {
    const code = await issueCode(14);
    const response = await harness.request(`/api/events/${eventId}/join-code`, {
      cookies: adminCookies,
    });
    const body = (await response.json()) as {
      code: string;
      expiresAt: string;
      expired: boolean;
    };
    expect(body.code).toBe(code);
    expect(body.expired).toBe(false);
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });
});

describe('redeeming one', () => {
  it('puts the player in the group and the event, and says where they landed', async () => {
    const code = await issueCode();
    const player = await signUp('levi@example.com', 'Levi Livermont');

    const response = await post('/api/join', { code }, player);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      name: 'DDD 2027',
      year: 2027,
      group: 'Divot Diggers',
    });
  });

  it('makes them a player and nothing more', async () => {
    const { rows } = await harness.privilegedPool.query<{ role: string }>(
      `SELECT m.role FROM org_members m JOIN people p ON p.id = m.person_id
        WHERE m.org_id = $1 AND p.email = $2`,
      [orgId, 'levi@example.com'],
    );
    expect(rows[0]?.role).toBe('member');

    const roles = await harness.privilegedPool.query<{ role: string }>(
      `SELECT r.role FROM event_roles r JOIN people p ON p.id = r.person_id
        WHERE r.event_id = $1 AND p.email = $2 ORDER BY r.role`,
      [eventId, 'levi@example.com'],
    );
    expect(roles.rows.map((row) => row.role)).toEqual(['player']);
  });

  it('does not put them on the roster, because that needs a target somebody decides', async () => {
    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM event_players ep JOIN people p ON p.id = ep.person_id
        WHERE ep.event_id = $1 AND p.email = $2`,
      [eventId, 'levi@example.com'],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('is harmless to redeem twice, for a player tapping it again on a bad signal', async () => {
    const code = await issueCode();
    const player = await signUp('twice@example.com', 'Double Tap');
    expect((await post('/api/join', { code }, player)).status).toBe(200);
    expect((await post('/api/join', { code }, player)).status).toBe(200);

    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM event_roles r JOIN people p ON p.id = r.person_id
        WHERE r.event_id = $1 AND p.email = $2`,
      [eventId, 'twice@example.com'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('is not case sensitive, and forgives a stray space', async () => {
    const code = await issueCode();
    const player = await signUp('sloppy@example.com', 'Fat Fingers');
    const response = await post('/api/join', { code: ` ${code.toLowerCase()} ` }, player);
    expect(response.status).toBe(200);
  });
});

describe('when it should not work', () => {
  it('refuses a code that has expired', async () => {
    const code = await issueCode();
    await harness.privilegedPool.query(
      `UPDATE events SET join_code_expires = now() - interval '1 hour' WHERE id = $1`,
      [eventId],
    );
    const player = await signUp('late@example.com', 'Late Arrival');
    const response = await post('/api/join', { code }, player);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/expired/i);
  });

  it('refuses one that has been withdrawn', async () => {
    const code = await issueCode();
    await post(`/api/events/${eventId}/join-code/clear`, {}, adminCookies);

    const player = await signUp('withdrawn@example.com', 'No Longer');
    const response = await post('/api/join', { code }, player);
    expect(response.status).toBe(410);

    const shown = await harness.request(`/api/events/${eventId}/join-code`, {
      cookies: adminCookies,
    });
    expect(((await shown.json()) as { code: string | null }).code).toBeNull();
  });

  it('refuses a made-up code', async () => {
    const player = await signUp('guesser@example.com', 'A Guesser');
    const response = await post('/api/join', { code: 'ZZZZZZ' }, player);
    expect(response.status).toBe(410);
  });

  it('refuses to issue one to somebody who does not run the group', async () => {
    const code = await issueCode();
    const player = await signUp('cheeky@example.com', 'Cheeky');
    await post('/api/join', { code }, player);

    // They are in the event as a player now, which must not let them mint codes.
    const response = await post(`/api/events/${eventId}/join-code`, { days: 30 }, player);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/group owner or group admin/i);
  });

  it('refuses an event that has finished', async () => {
    const code = await issueCode();
    // An event cannot be anything but a draft without frozen rules — the schema insists,
    // so finishing one properly means giving it the snapshot it would really have.
    await harness.privilegedPool.query(
      `UPDATE events SET status = 'completed',
              ruleset_snapshot = (SELECT document FROM rulesets WHERE org_id = $2 LIMIT 1)
        WHERE id = $1`,
      [eventId, orgId],
    );
    const player = await signUp('afterwards@example.com', 'Too Late Entirely');
    const response = await post('/api/join', { code }, player);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/finished/i);
    await harness.privilegedPool.query(
      `UPDATE events SET status = 'draft', ruleset_snapshot = NULL WHERE id = $1`,
      [eventId],
    );
  });

  it('needs somebody signed in — a code alone is not a way in', async () => {
    const code = await issueCode();
    const response = await harness.request('/api/join', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(401);
  });
});
