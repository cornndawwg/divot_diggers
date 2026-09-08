import type { PoolClient } from 'pg';
import type { TeamMatchPlayCompetition } from '@ddga/types';
import { rosterBalance, splitIntoSides } from '@ddga/scoring-engine';

export interface CupPlayer {
  readonly personId: string;
  readonly eventPlayerId: string;
  readonly displayName: string;
  readonly startingPtp: number;
  readonly isCaptain: boolean;
  readonly draftPick: number | null;
}

export interface CupTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly colour: string | null;
  readonly captainPersonId: string | null;
  readonly captainName: string | null;
  readonly players: CupPlayer[];
  /** Combined targets, so a planner can see at a glance whether the sides are level. */
  readonly totalPtp: number;
}

export interface CupBench {
  readonly personId: string;
  readonly eventPlayerId: string;
  readonly displayName: string;
  readonly startingPtp: number;
}

/**
 * Make sure the event has the two sides the ruleset describes.
 *
 * Names come from the ruleset the first time and are the planner's to change afterwards — a
 * group renames its teams most years, and the ruleset should not have to be republished for
 * that.
 */
export async function ensureTeams(
  client: PoolClient,
  eventId: string,
  cup: TeamMatchPlayCompetition,
): Promise<void> {
  for (const team of cup.teams) {
    await client.query(
      `INSERT INTO cup_teams (event_id, key, name) VALUES ($1,$2,$3)
       ON CONFLICT (event_id, key) DO NOTHING`,
      [eventId, team.id, team.name],
    );
  }
}

/** Everything the cup setup screen shows. */
export async function readCupSetup(
  client: PoolClient,
  eventId: string,
  cup: TeamMatchPlayCompetition,
): Promise<{
  teams: CupTeam[];
  unassigned: CupBench[];
  balance: ReturnType<typeof rosterBalance>;
}> {
  const teams = await client.query<{
    id: string;
    key: string;
    name: string;
    colour: string | null;
    captain_person_id: string | null;
    captain_name: string | null;
  }>(
    `SELECT t.id, t.key, t.name, t.colour, t.captain_person_id, p.display_name AS captain_name
       FROM cup_teams t LEFT JOIN people p ON p.id = t.captain_person_id
      WHERE t.event_id = $1 ORDER BY t.key`,
    [eventId],
  );

  const members = await client.query<{
    cup_team_id: string;
    person_id: string;
    event_player_id: string;
    display_name: string;
    starting_ptp: string;
    draft_pick_number: number | null;
  }>(
    `SELECT m.cup_team_id, ep.person_id, ep.id AS event_player_id, p.display_name,
            ep.starting_ptp, m.draft_pick_number
       FROM cup_team_members m
       JOIN cup_teams t ON t.id = m.cup_team_id
       JOIN event_players ep ON ep.id = m.event_player_id
       JOIN people p ON p.id = ep.person_id
      WHERE t.event_id = $1
      ORDER BY m.draft_pick_number NULLS LAST, ep.starting_ptp DESC, p.display_name`,
    [eventId],
  );

  const bench = await client.query<{
    person_id: string;
    event_player_id: string;
    display_name: string;
    starting_ptp: string;
  }>(
    `SELECT ep.person_id, ep.id AS event_player_id, p.display_name, ep.starting_ptp
       FROM event_players ep JOIN people p ON p.id = ep.person_id
      WHERE ep.event_id = $1
        AND NOT EXISTS (SELECT 1 FROM cup_team_members m WHERE m.event_player_id = ep.id)
      ORDER BY ep.starting_ptp DESC, p.display_name`,
    [eventId],
  );

  const roster = await client.query<{ count: string }>(
    'SELECT count(*) FROM event_players WHERE event_id = $1',
    [eventId],
  );

  return {
    teams: teams.rows.map((team) => {
      const players = members.rows
        .filter((member) => member.cup_team_id === team.id)
        .map((member) => ({
          personId: member.person_id,
          eventPlayerId: member.event_player_id,
          displayName: member.display_name,
          startingPtp: Number(member.starting_ptp),
          isCaptain: member.person_id === team.captain_person_id,
          draftPick: member.draft_pick_number,
        }));
      return {
        id: team.id,
        key: team.key,
        name: team.name,
        colour: team.colour,
        captainPersonId: team.captain_person_id,
        captainName: team.captain_name,
        players,
        totalPtp: players.reduce((sum, player) => sum + player.startingPtp, 0),
      };
    }),
    unassigned: bench.rows.map((row) => ({
      personId: row.person_id,
      eventPlayerId: row.event_player_id,
      displayName: row.display_name,
      startingPtp: Number(row.starting_ptp),
    })),
    balance: rosterBalance(Number(roster.rows[0]?.count ?? 0), cup),
  };
}

/**
 * Split the roster into two even sides by target.
 *
 * A suggestion only — captains draft in person at a table, and spec 4.3 is explicit that
 * nothing auto-commits. This is for the planner who wants a starting point, or a year where
 * the draft never happens.
 */
export async function suggestTeams(
  client: PoolClient,
  eventId: string,
  teamIds: readonly string[],
): Promise<number> {
  const roster = await client.query<{ id: string; starting_ptp: string }>(
    'SELECT id, starting_ptp FROM event_players WHERE event_id = $1',
    [eventId],
  );
  if (roster.rows.length === 0 || teamIds.length !== 2) return 0;

  const split = splitIntoSides(
    roster.rows.map((row) => ({
      player: { eventPlayerId: row.id },
      target: Number(row.starting_ptp),
    })),
  );

  await client.query('DELETE FROM cup_team_members WHERE cup_team_id = ANY($1::uuid[])', [
    [...teamIds],
  ]);

  let placed = 0;
  for (const [index, side] of [split.a, split.b].entries()) {
    const teamId = teamIds[index];
    if (teamId === undefined) continue;
    for (const player of side) {
      await client.query(
        'INSERT INTO cup_team_members (cup_team_id, event_player_id) VALUES ($1,$2)',
        [teamId, player.eventPlayerId],
      );
      placed += 1;
    }
  }
  return placed;
}
