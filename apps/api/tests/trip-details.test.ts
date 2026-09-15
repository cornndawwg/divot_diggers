import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookiesFrom, createAuthHarness, linkFrom, type AuthHarness } from './helpers/auth-harness.ts';

const RULESET = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)), 'utf8'),
) as unknown;

/**
 * What the trip is, what it costs, and who has settled up.
 *
 * The money here is a checklist, not a ledger: no card details, no balances, nothing moving.
 * The part that matters most is who can see it — what somebody owes is between them and
 * whoever is chasing them, and must not be readable by the rest of the field.
 */
let harness: AuthHarness;
let adminCookies = '';
let leviCookies = '';
let eventId = '';
let leviId = '';
let elliotId = '';

const PASSWORD = 'correct-horse-battery';

function post(path: string, body: unknown, cookies: string) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

async function account(email: string, name: string): Promise<string> {
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

async function trip(cookies: string) {
  return (await (
    await harness.request(`/api/events/${eventId}/trip`, { cookies })
  ).json()) as {
    notes: string | null;
    currency: string;
    mayEdit: boolean;
    costs: { label: string; amount: number | null; perPlayer: boolean }[];
    roster: { personId: string; displayName: string }[];
    payments: { displayName: string; category: string; paid: boolean }[];
  };
}

beforeAll(async () => {
  harness = await createAuthHarness('ddga_trip');
  adminCookies = await account('admin@example.com', 'The Admin');
  await post('/api/organizations', { name: 'Divot Diggers' }, adminCookies);
  await post('/api/rulesets', RULESET, adminCookies);
  eventId = ((await (
    await post('/api/events', { name: 'DDD 2027', year: 2027 }, adminCookies)
  ).json()) as { id: string }).id;

  await post(
    `/api/events/${eventId}/roster/import`,
    {
      rows: [
        { name: 'Levi Livermont', email: 'levi@example.com', startingPtp: 16 },
        { name: 'Elliot Griffiths', email: 'elliot@example.com', startingPtp: 38 },
      ],
    },
    adminCookies,
  );
  leviCookies = await account('levi@example.com', 'Levi Livermont');

  const ids = await harness.privilegedPool.query<{ id: string; email: string }>(
    'SELECT id, email FROM people WHERE email = ANY($1)',
    [['levi@example.com', 'elliot@example.com']],
  );
  leviId = ids.rows.find((r) => r.email === 'levi@example.com')?.id ?? '';
  elliotId = ids.rows.find((r) => r.email === 'elliot@example.com')?.id ?? '';
}, 180_000);

afterAll(async () => {
  await harness?.destroy();
});

describe('the trip as players read it', () => {
  it('holds whatever the group wants to say', async () => {
    const notes =
      'Thursday: first tee 8:10 at Heathland.\nStaying at the Marina Inn.\nPay Levi by 1 July.';
    expect((await post(`/api/events/${eventId}/trip/notes`, { notes }, adminCookies)).status).toBe(200);
    expect((await trip(adminCookies)).notes).toBe(notes);
  });

  it('holds a cost breakdown, in whole minor units', async () => {
    await post(
      `/api/events/${eventId}/trip/costs`,
      {
        items: [
          { label: 'Green fees, three rounds', amount: 42500, perPlayer: true },
          { label: 'Lodging', amount: 31000, perPlayer: true, note: 'Two to a room' },
          { label: 'Sunday steaks', amount: 18000, perPlayer: false },
          { label: 'Cart hire', note: 'Ask Levi' },
        ],
      },
      adminCookies,
    );
    const costs = (await trip(adminCookies)).costs;
    expect(costs).toHaveLength(4);
    expect(costs[0]).toMatchObject({ label: 'Green fees, three rounds', amount: 42500, perPlayer: true });
    // A line with no figure is legitimate — "ask Levi" is a real answer.
    expect(costs[3]?.amount).toBeNull();
  });

  it('keeps the order the admin put them in', async () => {
    const costs = (await trip(adminCookies)).costs;
    expect(costs.map((c) => c.label)).toEqual([
      'Green fees, three rounds',
      'Lodging',
      'Sunday steaks',
      'Cart hire',
    ]);
  });

  it('is readable by an ordinary player', async () => {
    const asLevi = await trip(leviCookies);
    expect(asLevi.notes).toContain('Marina Inn');
    expect(asLevi.costs).toHaveLength(4);
    expect(asLevi.mayEdit).toBe(false);
  });

  it('refuses to let a player rewrite it', async () => {
    expect((await post(`/api/events/${eventId}/trip/notes`, { notes: 'Free beer' }, leviCookies)).status).toBe(403);
    expect((await post(`/api/events/${eventId}/trip/costs`, { items: [] }, leviCookies)).status).toBe(403);
    expect((await trip(adminCookies)).costs).toHaveLength(4);
  });
});

describe('ticking off who has settled up', () => {
  it('records the trip cost against a player', async () => {
    const response = await post(
      `/api/events/${eventId}/trip/paid`,
      { personId: leviId, category: 'trip', paid: true, note: 'Venmo, 12 June' },
      adminCookies,
    );
    expect(response.status).toBe(200);

    const payments = (await trip(adminCookies)).payments;
    expect(payments).toContainEqual(
      expect.objectContaining({ displayName: 'Levi Livermont', category: 'trip', paid: true }),
    );
  });

  it('records a wager separately from the trip cost', async () => {
    await post(
      `/api/events/${eventId}/trip/paid`,
      { personId: leviId, category: 'wager', paid: false },
      adminCookies,
    );
    const payments = (await trip(adminCookies)).payments.filter((p) => p.displayName === 'Levi Livermont');
    expect(payments).toHaveLength(2);
    expect(payments.find((p) => p.category === 'trip')?.paid).toBe(true);
    expect(payments.find((p) => p.category === 'wager')?.paid).toBe(false);
  });

  it('can be un-ticked when somebody was marked in error', async () => {
    await post(
      `/api/events/${eventId}/trip/paid`,
      { personId: leviId, category: 'trip', paid: false },
      adminCookies,
    );
    const trips = (await trip(adminCookies)).payments.find(
      (p) => p.displayName === 'Levi Livermont' && p.category === 'trip',
    );
    expect(trips?.paid).toBe(false);
  });

  it('records who marked it and when, because that is the argument it settles', async () => {
    await post(`/api/events/${eventId}/trip/paid`, { personId: elliotId, paid: true }, adminCookies);
    const { rows } = await harness.privilegedPool.query<{
      marked_by: string | null;
      marked_at: string | null;
    }>('SELECT marked_by, marked_at FROM event_payments WHERE person_id = $1', [elliotId]);
    expect(rows[0]?.marked_by).not.toBeNull();
    expect(rows[0]?.marked_at).not.toBeNull();
  });

  it('gives an admin the whole roster, so nobody is missed', async () => {
    const roster = (await trip(adminCookies)).roster.map((r) => r.displayName);
    expect(roster).toEqual(['Elliot Griffiths', 'Levi Livermont']);
  });

  it('refuses to let a player mark themselves paid', async () => {
    const response = await post(
      `/api/events/${eventId}/trip/paid`,
      { personId: leviId, category: 'trip', paid: true },
      leviCookies,
    );
    expect(response.status).toBe(403);
  });

  it('refuses a category that is not something to settle', async () => {
    const response = await post(
      `/api/events/${eventId}/trip/paid`,
      { personId: leviId, category: 'bribe' },
      adminCookies,
    );
    expect(response.status).toBe(400);
  });
});

describe('ADVERSARIAL: who owes what is nobody else\'s business', () => {
  it('shows a player their own settlement and nobody else\'s', async () => {
    const asLevi = await trip(leviCookies);
    expect(asLevi.payments.every((p) => p.displayName === 'Levi Livermont')).toBe(true);
    expect(asLevi.payments.some((p) => p.displayName === 'Elliot Griffiths')).toBe(false);
  });

  it('does not hand a player the roster of who else is being chased', async () => {
    expect((await trip(leviCookies)).roster).toEqual([]);
  });

  it('holds nothing resembling a card number — it is a tick and a note', async () => {
    const { rows } = await harness.privilegedPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'event_payments'`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(['paid', 'note', 'category', 'marked_by', 'marked_at']),
    );
    // No amount, no balance, no instrument. Settling up happens between people.
    expect(columns).not.toContain('amount');
    expect(columns).not.toContain('balance');
  });
});
