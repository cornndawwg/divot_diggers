import type { PoolClient } from 'pg';
import type { Ruleset, TeamMatchPlayCompetition } from '@ddga/types';
import { matchesToTeeGroups, pairSides, type PairingStrategy } from '@ddga/scoring-engine';

/**
 * How a round's groups should be built.
 *
 * The two competitions want different things and it is a mistake to treat them alike. An
 * individual round does not care who you play with — any grouping is a fair grouping, and a
 * group would often rather it were a draw than arithmetic. A team round's groups *are* the
 * competition: two of one side against two of the other, and a foursome that mixes the teams
 * arbitrarily is not a match.
 */
export interface GroupingMode {
  readonly kind: 'individual' | 'match_play';
  /** The session being contested, for a match play round. */
  readonly sessionId: string | null;
  readonly formatName: string | null;
  /** One a side for singles, two for a pairs format. */
  readonly playersPerSide: number | null;
}

export const INDIVIDUAL_MODE: GroupingMode = {
  kind: 'individual',
  sessionId: null,
  formatName: null,
  playersPerSide: null,
};

/**
 * Work out which competition a round feeds, and so how its groups must be shaped.
 *
 * A round can feed both — a morning eighteen counting towards the individual competition
 * while an afternoon nine settles a cup session — so the cup takes precedence when a round
 * feeds one, because that is the constraint. The individual side has no constraint to lose.
 */
export async function groupingModeFor(
  client: PoolClient,
  roundId: string,
  ruleset: Ruleset | null,
): Promise<GroupingMode> {
  if (ruleset === null) return INDIVIDUAL_MODE;

  const cup = ruleset.competitions.find(
    (entry): entry is TeamMatchPlayCompetition => entry.type === 'team_match_play',
  );
  if (cup === undefined) return INDIVIDUAL_MODE;

  // The round's key is what ties it to the ruleset, and the cup's sessions name the rounds
  // they are played on. That mapping is the ruleset's to make, not the database's.
  const { rows } = await client.query<{ key: string }>('SELECT key FROM rounds WHERE id = $1', [
    roundId,
  ]);
  const session = cup.sessions.find((entry) => entry.roundId === rows[0]?.key);
  if (session === undefined) return INDIVIDUAL_MODE;

  return {
    kind: 'match_play',
    sessionId: session.roundId,
    formatName: session.format,
    playersPerSide: session.playersPerSide,
  };
}

export interface SideMember {
  readonly personId: string;
  readonly teamKey: string;
  readonly startingPtp: number;
}

/** Who is on which side for this event, ordered as the cup setup left them. */
export async function sidesFor(client: PoolClient, roundId: string): Promise<SideMember[]> {
  const { rows } = await client.query<{
    person_id: string;
    key: string;
    starting_ptp: string;
  }>(
    `SELECT ep.person_id, t.key, ep.starting_ptp
       FROM cup_team_members m
       JOIN cup_teams t ON t.id = m.cup_team_id
       JOIN event_players ep ON ep.id = m.event_player_id
       JOIN rounds r ON r.event_id = t.event_id
      WHERE r.id = $1
      ORDER BY t.key, ep.starting_ptp DESC`,
    [roundId],
  );
  return rows.map((row) => ({
    personId: row.person_id,
    teamKey: row.key,
    startingPtp: Number(row.starting_ptp),
  }));
}

export interface MatchPlayArrangement {
  readonly groups: { personId: string }[][];
  /** Players with no side to play for, or left over once the matches were made. */
  readonly sittingOut: string[];
}

/**
 * Build a match play tee sheet from the two cup sides.
 *
 * Anybody not on a team sits out rather than being padded into a group, because a player in a
 * match play group who is on neither side has nothing to play for and nothing to score.
 */
export function arrangeMatchPlay(
  members: readonly SideMember[],
  playersPerSide: number,
  strategy: PairingStrategy = 'by_rank',
): MatchPlayArrangement {
  const keys = [...new Set(members.map((member) => member.teamKey))].sort();
  const [keyA, keyB] = keys;
  if (keyA === undefined || keyB === undefined) return { groups: [], sittingOut: [] };

  const entriesFor = (key: string) =>
    members
      .filter((member) => member.teamKey === key)
      .map((member) => ({
        player: { personId: member.personId },
        target: member.startingPtp,
      }));

  const { matches, sittingOut } = pairSides(entriesFor(keyA), entriesFor(keyB), {
    playersPerSide,
    strategy,
  });

  return {
    groups: matchesToTeeGroups(matches, playersPerSide).map((group) => [...group.players]),
    sittingOut: [...sittingOut.a, ...sittingOut.b].map((player) => player.personId),
  };
}

/**
 * Check a hand-made match play sheet, without refusing it.
 *
 * A captain moving two players between groups knows something the arithmetic does not, so
 * this reports rather than blocks. Locking the sheet is what makes it final; until then the
 * warnings just say what is currently uneven.
 */
export function checkMatchPlayGroups(
  groups: readonly { personId: string }[][],
  members: readonly SideMember[],
  playersPerSide: number,
): string[] {
  const sideOf = new Map(members.map((member) => [member.personId, member.teamKey]));
  const warnings: string[] = [];

  groups.forEach((group, index) => {
    const label = `Group ${index + 1}`;
    const counts = new Map<string, number>();
    let unassigned = 0;

    for (const player of group) {
      const key = sideOf.get(player.personId);
      if (key === undefined) unassigned += 1;
      else counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    if (unassigned > 0) {
      warnings.push(
        `${label} has ${unassigned} player${unassigned === 1 ? '' : 's'} on neither team.`,
      );
    }
    if (counts.size === 1) {
      warnings.push(`${label} is all one team, so there is no match in it.`);
    }
    const sizes = [...counts.values()];
    if (counts.size === 2 && sizes[0] !== sizes[1]) {
      warnings.push(`${label} is ${sizes.join(' against ')}, so the sides are uneven.`);
    }
    if (counts.size === 2 && sizes[0] === sizes[1] && (sizes[0] ?? 0) % playersPerSide !== 0) {
      warnings.push(
        `${label} has ${String(sizes[0])} a side, which is not a whole number of ` +
          `${playersPerSide === 1 ? 'singles' : 'pairs'} matches.`,
      );
    }
  });

  const seated = new Set(groups.flat().map((player) => player.personId));
  const missing = members.filter((member) => !seated.has(member.personId));
  if (missing.length > 0) {
    warnings.push(
      `${String(missing.length)} player${missing.length === 1 ? ' is' : 's are'} on a team but not out on the course.`,
    );
  }

  return warnings;
}
