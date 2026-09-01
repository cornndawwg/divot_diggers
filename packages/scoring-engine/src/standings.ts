import type { IndividualTargetCompetition } from '@ddga/types';

export interface StandingInput<TPlayer> {
  readonly player: TPlayer;
  readonly finalStanding: number;
  /** Out of the running for this event — see `evaluateEligibility`. Defaults to false. */
  readonly disqualified?: boolean;
}

export interface StandingEntry<TPlayer> {
  readonly player: TPlayer;
  readonly finalStanding: number;
  /**
   * Sequential, 1..n over the eligible field. null for a disqualified player, who still
   * appears in the returned order so a leaderboard can show where they would have finished.
   */
  readonly position: number | null;
  /** True when at least one other eligible player finished on the same number. */
  readonly tied: boolean;
  readonly disqualified: boolean;
}

type StandingsConfig = Pick<IndividualTargetCompetition, 'standings'>;

/**
 * Order the field.
 *
 * Positions are sequential rather than shared, which is what the spreadsheet does: four
 * players on 6.0 in 2023 occupy positions 5, 6, 7 and 8 rather than four T5s. The sort is
 * stable, so tied players stay in the order they were handed in.
 *
 * `tied` is set on every entry sharing a number. The engine's job with a tie is to detect it
 * and hand it to the planner (spec 1.3), not to invent a winner.
 */
export function standings<TPlayer>(
  entries: readonly StandingInput<TPlayer>[],
  config: StandingsConfig,
): StandingEntry<TPlayer>[] {
  const direction = config.standings.direction === 'desc' ? -1 : 1;

  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byStanding = (a.entry.finalStanding - b.entry.finalStanding) * direction;
      // Stable tiebreak on the order the caller supplied.
      return byStanding !== 0 ? byStanding : a.index - b.index;
    });

  // Ties among disqualified players are not ties for anything, so only the eligible field
  // counts toward the flag.
  const occurrences = new Map<number, number>();
  for (const { entry } of ordered) {
    if (entry.disqualified === true) continue;
    occurrences.set(entry.finalStanding, (occurrences.get(entry.finalStanding) ?? 0) + 1);
  }

  let position = 0;
  return ordered.map(({ entry }) => {
    const disqualified = entry.disqualified === true;
    if (!disqualified) position += 1;

    return {
      player: entry.player,
      finalStanding: entry.finalStanding,
      position: disqualified ? null : position,
      tied: !disqualified && (occurrences.get(entry.finalStanding) ?? 0) > 1,
      disqualified,
    };
  });
}
