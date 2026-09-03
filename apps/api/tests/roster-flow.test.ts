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
 * Building a roster from the archive, the way a planner actually does it: pick people you
 * already know, add the newcomers once, and have next year's list already populated.
 */

const RULESET = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

let harness: AuthHarness;
let cookies = '';
let eventId = '';

beforeAll(async () => {
  harness = await createAuthHarness('ddga_roster');

  const email = 'planner@example.com';
  await harness.request('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'The Planner' }),
  });
  const link = linkFrom(harness.mailer.lastTo(email)?.text ?? '');
  await harness.request(link.slice(new URL(link).origin.length), { redirect: 'manual' });
  cookies = cookiesFrom(
    await harness.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-horse-battery' }),
    }),
  );

  await post('/api/organizations', { name: 'Divot Diggers' });
  await post('/api/rulesets', RULESET);
  const event = await post('/api/events', { name: 'DDD 2027', year: 2027 });
  eventId = ((await event.json()) as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await harness?.destroy();
});

function post(path: string, body: unknown) {
  return harness.request(path, { method: 'POST', body: JSON.stringify(body), cookies });
}

async function archive(eventFilter?: string) {
  const query = eventFilter === undefined ? '' : `?eventId=${eventFilter}`;
  const response = await harness.request(`/api/people${query}`, { cookies });
  return (await response.json()) as {
    people: {
      id: string;
      displayName: string;
      email: string | null;
      phone: string | null;
      lastYear: number | null;
      eventsPlayed: number;
      lastRating: { rounded: number } | null;
      onRoster: boolean;
    }[];
  };
}

describe('the archive starts with the planner and grows', () => {
  it('holds only the planner to begin with', async () => {
    const { people } = await archive();
    expect(people.map((person) => person.displayName)).toEqual(['The Planner']);
  });

  it('takes a new golfer with contact details', async () => {
    const response = await post('/api/people', {
      name: 'Kenny Adkins',
      email: 'kenny@example.com',
      phone: '555-0142',
    });
    expect(response.status).toBe(201);

    const { people } = await archive();
    const kenny = people.find((person) => person.displayName === 'Kenny Adkins');
    expect(kenny?.email).toBe('kenny@example.com');
    expect(kenny?.phone).toBe('555-0142');
    // Never played yet, so there is nothing to carry.
    expect(kenny?.lastRating).toBeNull();
    expect(kenny?.eventsPlayed).toBe(0);
  });

  it('does not duplicate a golfer already in the archive', async () => {
    await post('/api/people', { name: 'Kenny Adkins', email: 'KENNY@example.com', phone: null });
    const { people } = await archive();
    // citext, so the address matches regardless of case.
    expect(people.filter((person) => person.displayName === 'Kenny Adkins')).toHaveLength(1);
  });

  it('fills in a detail that was missing without overwriting one that was not', async () => {
    await post('/api/people', { name: 'Lee Butler', email: 'lee@example.com' });
    await post('/api/people', { name: 'Lee Butler', email: 'lee@example.com', phone: '555-0199' });
    const { people } = await archive();
    const lee = people.filter((person) => person.displayName === 'Lee Butler');
    expect(lee).toHaveLength(1);
    expect(lee[0]?.phone).toBe('555-0199');
  });

  it('refuses a golfer with no name', async () => {
    const response = await post('/api/people', { name: '   ' });
    expect(response.status).toBe(400);
  });
});

describe('picking a roster from the archive', () => {
  it('seeds a first-timer from their handicap index', async () => {
    const { people } = await archive();
    const kenny = people.find((person) => person.displayName === 'Kenny Adkins');

    const response = await post(`/api/events/${eventId}/players`, {
      personId: kenny?.id,
      handicapIndex: 38,
      source: 'seeded_from_handicap',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      startingTarget: { value: number; source: string; explanation: string };
    };
    // 54 − 38 = 16, from the ruleset's constant, not from code.
    expect(body.startingTarget.value).toBe(16);
    expect(body.startingTarget.source).toBe('seeded_from_handicap');
    expect(body.startingTarget.explanation).toMatch(/54 − 38 = 16/);
  });

  it('shows them on the roster with their contact details', async () => {
    const response = await harness.request(`/api/events/${eventId}/players`, { cookies });
    const body = (await response.json()) as {
      players: { displayName: string; phone: string | null; startingPtp: number; startingPtpSource: string }[];
    };
    const kenny = body.players.find((player) => player.displayName === 'Kenny Adkins');
    expect(kenny).toMatchObject({
      phone: '555-0142',
      startingPtp: 16,
      startingPtpSource: 'seeded_from_handicap',
    });
  });

  it('marks who is already on the roster, so the picker can grey them out', async () => {
    const { people } = await archive(eventId);
    const kenny = people.find((person) => person.displayName === 'Kenny Adkins');
    const lee = people.find((person) => person.displayName === 'Lee Butler');
    expect(kenny?.onRoster).toBe(true);
    expect(lee?.onRoster).toBe(false);
  });

  it('refuses a golfer with nothing to seed from', async () => {
    const { people } = await archive();
    const lee = people.find((person) => person.displayName === 'Lee Butler');
    const response = await post(`/api/events/${eventId}/players`, { personId: lee?.id });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/handicap index/);
  });

  it('keeps both numbers when the planner overrides a computed value', async () => {
    const { people } = await archive();
    const lee = people.find((person) => person.displayName === 'Lee Butler');

    // Give Lee a carried rating first, so there is something to override.
    const org = await harness.privilegedPool.query<{ id: string }>(
      'SELECT org_id AS id FROM events WHERE id = $1',
      [eventId],
    );
    await harness.privilegedPool.query(
      `INSERT INTO player_ratings (org_id, person_id, competition_key, raw_value, rounded_value, reason)
       VALUES ($1,$2,'dogfight',33.4,33,'event_carryover')`,
      [org.rows[0]?.id, lee?.id],
    );

    const carried = await post(`/api/events/${eventId}/players`, { personId: lee?.id });
    expect(((await carried.json()) as { startingTarget: { value: number } }).startingTarget.value).toBe(33);

    const overridden = await post(`/api/events/${eventId}/players`, {
      personId: lee?.id,
      startingPtp: 35,
      source: 'manual',
      overrideReason: 'handicap has moved since last year',
    });
    expect(overridden.status).toBe(201);

    const { rows } = await harness.privilegedPool.query<{
      starting_ptp: string;
      computed_ptp: string | null;
      override_reason: string | null;
      starting_ptp_source: string;
    }>(
      'SELECT starting_ptp, computed_ptp, override_reason, starting_ptp_source FROM event_players WHERE person_id = $1',
      [lee?.id],
    );
    expect(Number(rows[0]?.starting_ptp)).toBe(35);
    // The computed value is kept alongside, which is how the 2021 to 2022 overrides
    // would be reconstructable.
    expect(Number(rows[0]?.computed_ptp)).toBe(33);
    expect(rows[0]?.override_reason).toBe('handicap has moved since last year');
    expect(rows[0]?.starting_ptp_source).toBe('manual');
  });

  it('suggests a target for someone returning after a gap', async () => {
    const { people } = await archive();
    const lee = people.find((person) => person.displayName === 'Lee Butler');
    const response = await harness.request(
      `/api/events/${eventId}/players/${lee?.id}/suggestion?handicapIndex=17`,
      { cookies },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      requiresPlannerConfirmation: boolean;
      explanation: string;
    };
    expect(body.requiresPlannerConfirmation).toBe(true);
    expect(body.explanation).toMatch(/planner confirms/i);
  });
});

describe('roster balance, reported to the planner', () => {
  it('warns that two players cannot field the cup the ruleset describes', async () => {
    const response = await harness.request(`/api/events/${eventId}/roster-balance`, { cookies });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      playerCount: number;
      teamsEven: boolean;
      pointsAvailable: number;
      declaredPointsAvailable: number;
      issues: string[];
    };
    expect(body.playerCount).toBe(2);
    expect(body.teamsEven).toBe(true);
    expect(body.declaredPointsAvailable).toBe(24);
    // One player a side, so only the singles session can be played at all.
    expect(body.pointsAvailable).toBe(1);
    expect(body.issues.join(' ')).toMatch(/No match can be played/);
  });
});

describe('next year, the archive is already populated', () => {
  it('offers everyone from last year without retyping anything', async () => {
    const next = await post('/api/events', { name: 'DDD 2028', year: 2028 });
    const nextEventId = ((await next.json()) as { id: string }).id;

    const { people } = await archive(nextEventId);
    expect(people.map((person) => person.displayName).sort()).toEqual([
      'Kenny Adkins',
      'Lee Butler',
      'The Planner',
    ]);
    // A fresh event, so nobody is on it yet — but their details and history are there.
    expect(people.every((person) => !person.onRoster)).toBe(true);
    expect(people.find((p) => p.displayName === 'Kenny Adkins')?.phone).toBe('555-0142');
  });
});

describe('taking someone off a roster', () => {
  let victimId = '';

  beforeAll(async () => {
    await post('/api/people', { name: 'Dropped Out', email: 'dropped@example.com' });
    const { people } = await archive();
    victimId = people.find((person) => person.displayName === 'Dropped Out')?.id ?? '';
    await post(`/api/events/${eventId}/players`, {
      personId: victimId,
      handicapIndex: 24,
      source: 'seeded_from_handicap',
    });
  });

  it('removes them, and their player role with them', async () => {
    const response = await harness.request(`/api/events/${eventId}/players/${victimId}`, {
      method: 'DELETE',
      cookies,
    });
    expect(response.status).toBe(200);

    const roster = await harness.request(`/api/events/${eventId}/players`, { cookies });
    const body = (await roster.json()) as { players: { displayName: string }[] };
    expect(body.players.map((player) => player.displayName)).not.toContain('Dropped Out');

    const roles = await harness.privilegedPool.query<{ count: string }>(
      `SELECT count(*) FROM event_roles WHERE event_id = $1 AND person_id = $2 AND role = 'player'`,
      [eventId, victimId],
    );
    expect(roles.rows[0]?.count).toBe('0');
  });

  it('leaves them in the archive, ready to pick again', async () => {
    const { people } = await archive();
    expect(people.map((person) => person.displayName)).toContain('Dropped Out');
  });

  it('says so when they were not on the roster', async () => {
    const response = await harness.request(`/api/events/${eventId}/players/${victimId}`, {
      method: 'DELETE',
      cookies,
    });
    expect(response.status).toBe(404);
  });

  it('refuses to remove a player who already has scores, rather than deleting them', async () => {
    // Put them back and give them a scorecard with a hole on it.
    await post(`/api/events/${eventId}/players`, {
      personId: victimId,
      handicapIndex: 24,
      source: 'seeded_from_handicap',
    });
    const player = await harness.privilegedPool.query<{ id: string }>(
      'SELECT id FROM event_players WHERE event_id = $1 AND person_id = $2',
      [eventId, victimId],
    );
    const round = await harness.privilegedPool.query<{ id: string }>(
      `INSERT INTO rounds (event_id, key, name, sequence) VALUES ($1,'scored','Scored',99) RETURNING id`,
      [eventId],
    );
    const card = await harness.privilegedPool.query<{ id: string }>(
      `INSERT INTO scorecards (round_id, event_player_id, status) VALUES ($1,$2,'in_progress') RETURNING id`,
      [round.rows[0]?.id, player.rows[0]?.id],
    );
    await harness.privilegedPool.query(
      `INSERT INTO hole_scores (scorecard_id, hole_number, strokes, entered_by, client_uuid)
       VALUES ($1, 1, 5, (SELECT id FROM people WHERE email = 'planner@example.com'), gen_random_uuid())`,
      [card.rows[0]?.id],
    );

    const response = await harness.request(`/api/events/${eventId}/players/${victimId}`, {
      method: 'DELETE',
      cookies,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already has scores/i);

    // And the scores are still there, which is the whole point.
    const holes = await harness.privilegedPool.query<{ count: string }>(
      'SELECT count(*) FROM hole_scores WHERE scorecard_id = $1',
      [card.rows[0]?.id],
    );
    expect(holes.rows[0]?.count).toBe('1');
  });
});

describe('removing someone from the archive', () => {
  let goneId = '';

  beforeAll(async () => {
    await post('/api/people', { name: 'No Longer With Us', email: 'gone@example.com' });
    const { people } = await archive();
    goneId = people.find((person) => person.displayName === 'No Longer With Us')?.id ?? '';

    const org = await harness.privilegedPool.query<{ id: string }>(
      'SELECT org_id AS id FROM events WHERE id = $1',
      [eventId],
    );
    await harness.privilegedPool.query(
      `INSERT INTO player_ratings (org_id, person_id, competition_key, raw_value, rounded_value, reason)
       VALUES ($1,$2,'dogfight',21.5,22,'event_carryover')`,
      [org.rows[0]?.id, goneId],
    );
  });

  it('takes them out of the picker', async () => {
    const response = await harness.request(`/api/people/${goneId}`, { method: 'DELETE', cookies });
    expect(response.status).toBe(200);

    const { people } = await archive();
    expect(people.map((person) => person.displayName)).not.toContain('No Longer With Us');
  });

  it('keeps their rating history, because that is the PTP lineage', async () => {
    const { rows } = await harness.privilegedPool.query<{ rounded_value: number }>(
      'SELECT rounded_value FROM player_ratings WHERE person_id = $1',
      [goneId],
    );
    expect(rows.map((row) => row.rounded_value)).toEqual([22]);
  });

  it('lists them separately, so they can be found again', async () => {
    const response = await harness.request('/api/people?removed=true', { cookies });
    const body = (await response.json()) as { people: { displayName: string }[] };
    expect(body.people.map((person) => person.displayName)).toEqual(['No Longer With Us']);
  });

  it('puts them back with everything intact', async () => {
    const restored = await harness.request(`/api/people/${goneId}/restore`, {
      method: 'POST',
      cookies,
    });
    expect(restored.status).toBe(200);

    const { people } = await archive();
    const back = people.find((person) => person.displayName === 'No Longer With Us');
    expect(back).toBeDefined();
    expect(back?.lastRating?.rounded).toBe(22);
  });

  it('refuses to let the planner remove themselves', async () => {
    const { people } = await archive();
    const planner = people.find((person) => person.displayName === 'The Planner');
    const response = await harness.request(`/api/people/${planner?.id}`, {
      method: 'DELETE',
      cookies,
    });
    expect(response.status).toBe(409);
  });
});
