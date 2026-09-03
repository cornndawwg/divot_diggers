import type { PoolClient } from 'pg';
import type { IndividualTargetCompetition } from '@ddga/types';
import {
  DID_NOT_PLAY,
  runIndividualTarget,
  type IndividualTargetEntry,
  type IndividualTargetResult,
  type RoundInput,
} from '@ddga/scoring-engine';

export interface StandingsPlayer {
  readonly eventPlayerId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly startingPtp: number;
}

export interface RoundRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly sequence: number;
  readonly holesInPlay: number | null;
}

/**
 * Read an event's scores and score them.
 *
 * Everything comes from the scorecards: nothing is read back out of dogfight_results, because
 * that table is a cache and trusting a cache to compute the next value is how a wrong number
 * becomes permanent. The engine does the arithmetic.
 */
export async function computeStandings(
  client: PoolClient,
  eventId: string,
  competition: IndividualTargetCompetition,
): Promise<{
  readonly rounds: readonly RoundRef[];
  readonly results: readonly IndividualTargetResult<StandingsPlayer>[];
}> {
  const roundRows = await client.query<{
    id: string;
    key: string;
    name: string;
    sequence: number;
    hole_selection: { mode?: string; holes?: number[] } | null;
    tee_holes: number | null;
  }>(
    `SELECT r.id, r.key, r.name, r.sequence, r.hole_selection,
            (SELECT count(*)::int FROM course_holes h WHERE h.tee_set_id = r.tee_set_id) AS tee_holes
       FROM rounds r
      WHERE r.event_id = $1 AND r.key = ANY($2::text[])
      ORDER BY r.sequence`,
    [eventId, [...competition.rounds]],
  );

  const rounds: RoundRef[] = roundRows.rows.map((row) => {
    const mode = row.hole_selection?.mode;
    const explicit = row.hole_selection?.holes?.length;
    const holesInPlay =
      explicit !== undefined && explicit > 0
        ? explicit
        : mode === 'front9' || mode === 'back9'
          ? 9
          : row.tee_holes !== null && row.tee_holes > 0
            ? row.tee_holes
            : null;
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      sequence: row.sequence,
      holesInPlay,
    };
  });

  const players = await client.query<{
    id: string;
    person_id: string;
    display_name: string;
    starting_ptp: string;
  }>(
    `SELECT ep.id, ep.person_id, p.display_name, ep.starting_ptp
       FROM event_players ep JOIN people p ON p.id = ep.person_id
      WHERE ep.event_id = $1
      ORDER BY p.display_name`,
    [eventId],
  );

  const scores = await client.query<{
    event_player_id: string;
    round_id: string;
    did_not_play: boolean;
    entry_mode: string;
    points_pulled_manual: number | null;
    hole_points: number | null;
  }>(
    `SELECT s.event_player_id, s.round_id, s.did_not_play, s.entry_mode,
            s.points_pulled_manual, NULL::int AS hole_points
       FROM scorecards s
       JOIN rounds r ON r.id = s.round_id
      WHERE r.event_id = $1`,
    [eventId],
  );

  const byPlayerRound = new Map<string, (typeof scores.rows)[number]>();
  for (const row of scores.rows) {
    byPlayerRound.set(`${row.event_player_id}:${row.round_id}`, row);
  }

  const entries: IndividualTargetEntry<StandingsPlayer>[] = players.rows.map((row) => {
    const pointsPulled: RoundInput[] = rounds.map((round) => {
      const card = byPlayerRound.get(`${row.id}:${round.id}`);
      if (card === undefined || card.did_not_play) return DID_NOT_PLAY;
      if (card.entry_mode === 'totals_only') {
        return card.points_pulled_manual ?? DID_NOT_PLAY;
      }
      return card.hole_points ?? DID_NOT_PLAY;
    });

    const holes = rounds.map((round) => round.holesInPlay);
    const everyRoundKnown = holes.every((count): count is number => count !== null);

    return {
      player: {
        eventPlayerId: row.id,
        personId: row.person_id,
        displayName: row.display_name,
        startingPtp: Number(row.starting_ptp),
      },
      startingTarget: Number(row.starting_ptp),
      pointsPulled,
      ...(everyRoundKnown ? { holesInPlay: holes } : {}),
    };
  });

  // No rounds yet is an empty leaderboard, not a failure: an event exists before it is
  // played, and the roster screen asks for standings the moment it is created.
  if (rounds.length === 0 || entries.length === 0) {
    return { rounds, results: [] };
  }
  return { rounds, results: runIndividualTarget(entries, competition) };
}

/**
 * Rewrite the results cache from the scores.
 *
 * Cleared and rebuilt rather than updated in place, because the cache must never hold a row
 * that the scores no longer justify — a player taken off the roster, or a round removed.
 */
export async function rebuildResults(
  client: PoolClient,
  eventId: string,
  competition: IndividualTargetCompetition,
  engineVersion: string,
): Promise<number> {
  const { rounds, results } = await computeStandings(client, eventId, competition);

  await client.query(
    `DELETE FROM dogfight_results
      WHERE round_id IN (SELECT id FROM rounds WHERE event_id = $1)`,
    [eventId],
  );

  let written = 0;
  for (const result of results) {
    for (const [index, round] of rounds.entries()) {
      const outcome = result.event.rounds[index];
      if (outcome === undefined) continue;

      await client.query(
        `INSERT INTO dogfight_results
           (round_id, event_player_id, target, points_pulled, round_delta, cumulative_delta,
            disqualified, position, engine_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          round.id,
          result.player.eventPlayerId,
          outcome.effectiveTarget,
          outcome.pointsPulled,
          outcome.roundDelta,
          outcome.runningTotal,
          !result.eligibility.eligible,
          // Position is a standing on the event, so it is stamped on the final round only.
          index === rounds.length - 1 ? result.position : null,
          engineVersion,
        ],
      );
      written += 1;
    }
  }

  return written;
}
