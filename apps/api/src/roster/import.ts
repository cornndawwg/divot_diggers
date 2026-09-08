import type { PoolClient } from 'pg';
import type { Target } from '@ddga/types';
import {
  carriedStartingTarget,
  manualStartingTarget,
  seedFromHandicap,
  type StartingTarget,
} from '@ddga/scoring-engine';

export interface RosterImportRow {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly phone?: unknown;
  readonly handicapIndex?: unknown;
  readonly startingPtp?: unknown;
}

export interface RosterImportOutcome {
  readonly name: string;
  readonly status: 'added' | 'skipped' | 'no target';
  readonly detail: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Add many golfers to a roster at once.
 *
 * Shared by the API endpoint and the seed command so the two cannot drift. Everything goes
 * through the same archive and seeding paths a single add uses. The caller owns the
 * transaction, because a half-imported roster is worse than none.
 *
 * Where a starting target is given it wins, because a planner typing a number is making a
 * decision. Otherwise a carried rating beats a handicap, since a golfer with history should
 * not be reseeded as though they were new.
 */
export async function importRosterRows(
  client: PoolClient,
  orgId: string,
  eventId: string,
  target: Target,
  rows: readonly RosterImportRow[],
): Promise<RosterImportOutcome[]> {
  const outcome: RosterImportOutcome[] = [];

  for (const row of rows) {
    const name = text(row.name);
    if (name === null) {
      outcome.push({ name: '(blank)', status: 'skipped', detail: 'No name in this row.' });
      continue;
    }

    const person = await client.query<{ add_org_person: string }>(
      'SELECT add_org_person($1, $2, $3, $4)',
      [orgId, name, text(row.email), text(row.phone)],
    );
    const personId = person.rows[0]?.add_org_person;
    if (personId === undefined) {
      outcome.push({ name, status: 'skipped', detail: 'Could not add them.' });
      continue;
    }

    const handicapIndex = num(row.handicapIndex);
    const manualPtp = num(row.startingPtp);

    const prior = await client.query<{ raw_value: string }>(
      `SELECT raw_value FROM player_ratings
        WHERE person_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [personId, orgId],
    );
    const carriedRaw = prior.rows[0] === undefined ? null : Number(prior.rows[0].raw_value);

    let seeded: StartingTarget;
    if (manualPtp !== null) {
      seeded = manualStartingTarget(manualPtp, 'imported from a spreadsheet');
    } else if (carriedRaw !== null) {
      seeded = carriedStartingTarget(carriedRaw, target);
    } else if (handicapIndex !== null) {
      seeded = seedFromHandicap(handicapIndex, target);
    } else {
      outcome.push({
        name,
        status: 'no target',
        detail: 'Added to the archive, but needs a handicap or a starting target to play.',
      });
      continue;
    }

    await client.query(
      `INSERT INTO event_players
         (event_id, person_id, handicap_index, starting_ptp, starting_ptp_source)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id, person_id) DO UPDATE
         SET handicap_index = excluded.handicap_index,
             starting_ptp = excluded.starting_ptp,
             starting_ptp_source = excluded.starting_ptp_source`,
      [eventId, personId, handicapIndex, seeded.value, seeded.source],
    );
    await client.query(
      `INSERT INTO event_roles (event_id, person_id, role) VALUES ($1,$2,'player')
       ON CONFLICT (event_id, person_id, role) DO NOTHING`,
      [eventId, personId],
    );

    outcome.push({ name, status: 'added', detail: seeded.explanation });
  }

  return outcome;
}
