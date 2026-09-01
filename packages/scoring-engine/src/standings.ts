import type { IndividualTargetCompetition } from '@ddga/types';

export interface StandingInput<TPlayer> {
  readonly player: TPlayer;
  readonly finalStanding: number;
}

export interface StandingEntry<TPlayer> {
  readonly player: TPlayer;
  readonly finalStanding: number;
  /** Sequential, 1..n. Tied players take consecutive positions in roster order. */
  readonly position: number;
  /** True when at least one other player finished on the same number. */
  readonly tied: boolean;
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

  const occurrences = new Map<number, number>();
  for (const { entry } of ordered) {
    occurrences.set(entry.finalStanding, (occurrences.get(entry.finalStanding) ?? 0) + 1);
  }

  return ordered.map(({ entry }, rank) => ({
    player: entry.player,
    finalStanding: entry.finalStanding,
    position: rank + 1,
    tied: (occurrences.get(entry.finalStanding) ?? 0) > 1,
  }));
}
