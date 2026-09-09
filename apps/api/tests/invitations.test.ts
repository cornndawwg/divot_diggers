import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

/**
 * Getting a second person into a group.
 *
 * Before migration 0018 there was no way at all: a group's only member was whoever created
 * it, and no role could be given to anybody. This is the whole path — invite, email, accept,
 * hold the role — plus the ways it must refuse.
 */
let harness: AuthHarness;
let ownerCookies = '';
let orgId = '';

const PASSWORD = 'correct-horse-battery';

/** Sign up, verify by email, sign in. The real flow, as a browser would do it. */
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

/** The token out of the invitation email, exactly as the recipient would click it. */
function tokenFrom(email: string): string {
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  return new URL(link).searchParams.get('token') ?? '';
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_invites');
  ownerCookies = await signUp('owner@example.com', 'The Owner');
  const created = await post('/api/organizations', { name: 'Divot Diggers' }, ownerCookies);
  orgId = ((await created.json()) as { id: string }).id;
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('the group as created', () => {
  it('has exactly one member, its owner', async () => {
    const response = await harness.request(`/api/organizations/${orgId}/members`, {
      cookies: ownerCookies,
    });
    const body = (await response.json()) as {
      members: { displayName: string; role: string }[];
      invitations: unknown[];
    };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.role).toBe('owner');
    expect(body.invitations).toEqual([]);
  });
});

describe('inviting somebody who has no account yet', () => {
  it('sends them an email with a link', async () => {
    const response = await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'levi@example.com', role: 'owner' },
      ownerCookies,
    );
    expect(response.status).toBe(201);

    const email = harness.mailer.lastTo('levi@example.com');
    expect(email?.subject).toContain('Divot Diggers');
    expect(email?.text).toContain('Group Owner');
    expect(tokenFrom('levi@example.com')).not.toBe('');
  });

  it('shows as outstanding until it is used', async () => {
    const response = await harness.request(`/api/organizations/${orgId}/members`, {
      cookies: ownerCookies,
    });
    const body = (await response.json()) as { invitations: { email: string; role: string }[] };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({ email: 'levi@example.com', role: 'owner' });
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const token = tokenFrom('levi@example.com');
    const { rows } = await harness.privilegedPool.query<{ token_hash: string }>(
      'SELECT token_hash FROM org_invitations WHERE lower(email) = $1',
      ['levi@example.com'],
    );
    expect(rows[0]?.token_hash).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets them accept once they have signed up, and they hold the role', async () => {
    const token = tokenFrom('levi@example.com');
    const leviCookies = await signUp('levi@example.com', 'Levi Livermont');

    const accepted = await post('/api/invitations/accept', { token }, leviCookies);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as { name: string }).toMatchObject({ name: 'Divot Diggers' });

    const members = (await (
      await harness.request(`/api/organizations/${orgId}/members`, { cookies: ownerCookies })
    ).json()) as { members: { displayName: string; role: string }[] };
    expect(members.members.find((m) => m.displayName === 'Levi Livermont')?.role).toBe('owner');
  });

  it('and can now administer events he did not create', async () => {
    const leviCookies = await signUp('levi@example.com', 'Levi Livermont');
    const event = await post(
      '/api/events',
      { name: 'Made by the first owner', year: 2028 },
      ownerCookies,
    );
    const eventId = ((await event.json()) as { id: string }).id;

    // A group owner administers every event the group has, including ones set up before
    // they arrived. Under the old per-event model this was simply impossible.
    const person = await post('/api/people', { name: 'A Newcomer' }, leviCookies);
    const personId = ((await person.json()) as { id: string }).id;
    const response = await post(
      `/api/events/${eventId}/players`,
      { personId, startingPtp: 30, source: 'manual' },
      leviCookies,
    );
    expect(response.status).toBeLessThan(400);
  });

  it('refuses the same link a second time', async () => {
    // Re-invite so there is a fresh token, accept it, then try that same one again.
    await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'levi@example.com', role: 'admin' },
      ownerCookies,
    );
    const token = tokenFrom('levi@example.com');
    const leviCookies = await signUp('levi@example.com', 'Levi Livermont');
    expect((await post('/api/invitations/accept', { token }, leviCookies)).status).toBe(200);

    const again = await post('/api/invitations/accept', { token }, leviCookies);
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: string }).error).toMatch(/already been used/i);
  });
});

describe('what an invitation will not do', () => {
  it('refuses a made-up token', async () => {
    const cookies = await signUp('nobody@example.com', 'Nobody');
    const response = await post('/api/invitations/accept', { token: 'not-a-real-token' }, cookies);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/not valid/i);
  });

  it('refuses one that was withdrawn', async () => {
    await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'changed-my-mind@example.com', role: 'member' },
      ownerCookies,
    );
    const token = tokenFrom('changed-my-mind@example.com');

    const listed = (await (
      await harness.request(`/api/organizations/${orgId}/members`, { cookies: ownerCookies })
    ).json()) as { invitations: { id: string; email: string }[] };
    const invite = listed.invitations.find((i) => i.email === 'changed-my-mind@example.com');
    await post(
      `/api/organizations/${orgId}/invitations/${invite?.id}/revoke`,
      {},
      ownerCookies,
    );

    const cookies = await signUp('changed-my-mind@example.com', 'Second Thoughts');
    const response = await post('/api/invitations/accept', { token }, cookies);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/withdrawn/i);
  });

  it('refuses one that has expired', async () => {
    await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'too-late@example.com', role: 'member' },
      ownerCookies,
    );
    const token = tokenFrom('too-late@example.com');
    await harness.privilegedPool.query(
      `UPDATE org_invitations SET expires_at = now() - interval '1 day'
        WHERE lower(email) = $1`,
      ['too-late@example.com'],
    );

    const cookies = await signUp('too-late@example.com', 'Too Late');
    const response = await post('/api/invitations/accept', { token }, cookies);
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toMatch(/expired/i);
  });

  it('refuses to let an outsider invite themselves in, without admitting the group exists', async () => {
    const cookies = await signUp('chancer@example.com', 'A Chancer');
    const response = await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'chancer@example.com', role: 'owner' },
      cookies,
    );
    // 404, not 403: row level security hides the group from them entirely, so the honest
    // answer is that there is no such group as far as they are concerned. Confirming it
    // exists would tell a stranger which groups are real.
    expect(response.status).toBe(404);

    const { rows } = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM org_invitations WHERE lower(email) = $1',
      ['chancer@example.com'],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuses to let a group admin invite an owner', async () => {
    await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'helper@example.com', role: 'admin' },
      ownerCookies,
    );
    const token = tokenFrom('helper@example.com');
    const helperCookies = await signUp('helper@example.com', 'A Helper');
    await post('/api/invitations/accept', { token }, helperCookies);

    const response = await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'their-friend@example.com', role: 'owner' },
      helperCookies,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/only a group owner/i);

    // But inviting an ordinary member is squarely their job.
    const allowed = await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'their-friend@example.com', role: 'member' },
      helperCookies,
    );
    expect(allowed.status).toBe(201);
  });

  it('rejects an address that is not one', async () => {
    const response = await post(
      `/api/organizations/${orgId}/invitations`,
      { email: 'levi at example dot com', role: 'member' },
      ownerCookies,
    );
    expect(response.status).toBe(400);
  });
});
