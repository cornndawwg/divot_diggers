import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  seed,
  EVENT_A,
  GUEST,
  INSIDER,
  ORG_A,
  ORG_B,
  OUTSIDER,
  type TestDatabase,
} from './helpers/test-database';

/**
 * Group Owner and Group Admin, from migration 0017.
 *
 * Authority over events belongs to the group. Before this, the only way to hold any was to
 * create an event — which meant a group's owner could not administer an event somebody else
 * had made, and nobody could ever be given authority over anything.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase('ddga_group_roles');
  await seed(database.owner);
  // GUEST is a person in org A's world but holds no role in it at all.
  await database.owner.query(
    `INSERT INTO org_members (org_id, person_id, role) VALUES ($1,$2,'member')
     ON CONFLICT (org_id, person_id) DO UPDATE SET role = 'member', removed_at = NULL`,
    [ORG_A, GUEST],
  );
}, 90_000);

afterAll(async () => {
  await database?.destroy();
});

/** Ask the database, as this person, whether they may administer the event. */
async function mayAdminister(personId: string, eventId = EVENT_A): Promise<boolean> {
  return database.asPerson(personId, async (client) => {
    const { rows } = await client.query<{ allowed: boolean }>(
      'SELECT has_event_role($1, $2) AS allowed',
      [eventId, 'planner'],
    );
    return rows[0]?.allowed === true;
  });
}

async function roleOf(personId: string, org = ORG_A): Promise<string | null> {
  const { rows } = await database.owner.query<{ role: string }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND person_id = $2 AND removed_at IS NULL',
    [org, personId],
  );
  return rows[0]?.role ?? null;
}

describe('who may administer an event', () => {
  it('the group owner may, without any per-event grant', async () => {
    expect(await roleOf(INSIDER)).toBe('owner');
    expect(await mayAdminister(INSIDER)).toBe(true);
  });

  it('an ordinary group member may not', async () => {
    expect(await roleOf(GUEST)).toBe('member');
    expect(await mayAdminister(GUEST)).toBe(false);
  });

  it('somebody from another group certainly may not', async () => {
    expect(await roleOf(OUTSIDER)).toBeNull();
    expect(await mayAdminister(OUTSIDER)).toBe(false);
  });

  it('a group admin may, and stops being able to when the role is taken away', async () => {
    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'admin']),
    );
    expect(await mayAdminister(GUEST)).toBe(true);

    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'member']),
    );
    // The point of moving authority to the group: withdrawing it actually withdraws it,
    // leaving nothing behind on events they may have set up.
    expect(await mayAdminister(GUEST)).toBe(false);
  });

  it('being a group admin does not make anybody a captain', async () => {
    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'admin']),
    );
    const isCaptain = await database.asPerson(GUEST, async (client) => {
      const { rows } = await client.query<{ allowed: boolean }>(
        'SELECT has_event_role($1,$2) AS allowed',
        [EVENT_A, 'captain'],
      );
      return rows[0]?.allowed === true;
    });
    expect(isCaptain).toBe(false);
    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'member']),
    );
  });
});

describe('changing who does what', () => {
  it('an ordinary member cannot promote themselves', async () => {
    await expect(
      database.asPerson(GUEST, (client) =>
        client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'admin']),
      ),
    ).rejects.toThrow(/only a group owner or group admin/i);
    expect(await roleOf(GUEST)).toBe('member');
  });

  it('an admin cannot make themselves an owner', async () => {
    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'admin']),
    );
    await expect(
      database.asPerson(GUEST, (client) =>
        client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'owner']),
      ),
    ).rejects.toThrow(/only a group owner/i);
    expect(await roleOf(GUEST)).toBe('admin');
  });

  it('nor demote the owner out from under them', async () => {
    await expect(
      database.asPerson(GUEST, (client) =>
        client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, INSIDER, 'member']),
      ),
    ).rejects.toThrow(/only a group owner/i);
    expect(await roleOf(INSIDER)).toBe('owner');
  });

  it('refuses to leave a group with no owner at all', async () => {
    await expect(
      database.asPerson(INSIDER, (client) =>
        client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, INSIDER, 'admin']),
      ),
    ).rejects.toThrow(/only owner/i);
    expect(await roleOf(INSIDER)).toBe('owner');
  });

  it('but lets an owner hand over once there are two of them', async () => {
    // The handover this was built for: Levi becomes the group's owner, and the person who
    // set the group up stays on as an admin to help.
    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, GUEST, 'owner']),
    );
    expect(await roleOf(GUEST)).toBe('owner');

    await database.asPerson(INSIDER, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, INSIDER, 'admin']),
    );
    expect(await roleOf(INSIDER)).toBe('admin');
    expect(await mayAdminister(INSIDER)).toBe(true);
  });

  it('cannot reach into another group', async () => {
    await expect(
      database.asPerson(INSIDER, (client) =>
        client.query('SELECT set_org_role($1,$2,$3)', [ORG_B, INSIDER, 'owner']),
      ),
    ).rejects.toThrow(/only a group owner or group admin/i);
  });
});

describe('creating an event', () => {
  it('takes a group owner or admin, not just any member', async () => {
    await database.asPerson(GUEST, (client) =>
      client.query('SELECT set_org_role($1,$2,$3)', [ORG_A, OUTSIDER, 'member']),
    );
    await expect(
      database.asPerson(OUTSIDER, (client) =>
        client.query('SELECT create_event($1,$2,$3)', [ORG_A, 'Sneaky Event', 2031]),
      ),
    ).rejects.toThrow(/only a group owner or group admin/i);
  });

  it('leaves no per-event planner grant behind, because the group role is the authority', async () => {
    const created = await database.asPerson(GUEST, async (client) => {
      const { rows } = await client.query<{ create_event: string }>(
        'SELECT create_event($1,$2,$3)',
        [ORG_A, 'Properly Made', 2032],
      );
      return rows[0]?.create_event;
    });
    expect(created).toBeDefined();

    const { rows } = await database.owner.query<{ role: string }>(
      'SELECT role FROM event_roles WHERE event_id = $1 ORDER BY role',
      [created],
    );
    expect(rows.map((r) => r.role)).toEqual(['player']);
    // They can still administer it — via the group, which is the whole point.
    expect(await mayAdminister(GUEST, created as string)).toBe(true);
  });
});
