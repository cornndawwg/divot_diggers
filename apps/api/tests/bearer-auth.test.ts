import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

/**
 * Signing in from a phone.
 *
 * The console is a browser and uses cookies. A phone is not: React Native has no cookie jar
 * worth relying on, and a session has to survive the app being killed and the phone rebooted.
 * So the app keeps a token in the device keychain and sends it as a bearer header. These
 * tests pin that it works everywhere a cookie does — and, more importantly, that it is not a
 * second, weaker way in.
 */
let harness: AuthHarness;
const PASSWORD = 'correct-horse-battery';

async function verifiedAccount(email: string, name: string): Promise<void> {
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
}

/** Sign in the way the phone does: keep the token, discard the cookie. */
async function tokenFor(email: string): Promise<string> {
  const response = await harness.request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return response.headers.get('set-auth-token') ?? '';
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_bearer');
  await verifiedAccount('phone@example.com', 'A Phone Owner');
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('a token instead of a cookie', () => {
  it('is handed out on sign-in', async () => {
    expect(await tokenFor('phone@example.com')).not.toBe('');
  });

  it('identifies the golfer with no cookie anywhere in the request', async () => {
    const token = await tokenFor('phone@example.com');
    const response = await harness.request('/api/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { displayName: string }).toMatchObject({
      displayName: 'A Phone Owner',
    });
  });

  it('works on the domain endpoints too, not just the session lookup', async () => {
    const token = await tokenFor('phone@example.com');
    const response = await harness.request('/api/organizations', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Phone Group' }),
    });
    expect(response.status).toBeLessThan(400);
  });

  it('survives being sent again later, which is the whole point', async () => {
    const token = await tokenFor('phone@example.com');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await harness.request('/api/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    }
  });
});

describe('ADVERSARIAL: the token is not a weaker door', () => {
  it('refuses a made-up token', async () => {
    const response = await harness.request('/api/me', {
      headers: { authorization: 'Bearer not-a-real-session-token' },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a token with a character changed', async () => {
    const token = await tokenFor('phone@example.com');
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const response = await harness.request('/api/me', {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(response.status).toBe(401);
  });

  it('refuses an empty one', async () => {
    const response = await harness.request('/api/me', { headers: { authorization: 'Bearer ' } });
    expect(response.status).toBe(401);
  });

  it('still refuses a request carrying nothing at all', async () => {
    expect((await harness.request('/api/me')).status).toBe(401);
  });

  it('stops working once that session is signed out', async () => {
    const token = await tokenFor('phone@example.com');
    expect((await harness.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    await harness.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    const after = await harness.request('/api/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it('does not let an unverified account in, exactly as the cookie path does not', async () => {
    await harness.request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        email: 'unverified@example.com',
        password: PASSWORD,
        name: 'Not Verified',
      }),
    });
    const response = await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'unverified@example.com', password: PASSWORD }),
    });
    expect(response.headers.get('set-auth-token')).toBeNull();
  });
});

describe('cookies still work', () => {
  it('because the console has not changed', async () => {
    await verifiedAccount('browser@example.com', 'A Browser User');
    const cookies = cookiesFrom(
      await harness.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'browser@example.com', password: PASSWORD }),
      }),
    );
    const response = await harness.request('/api/me', { cookies });
    expect(response.status).toBe(200);
    expect((await response.json()) as { displayName: string }).toMatchObject({
      displayName: 'A Browser User',
    });
  });
});
