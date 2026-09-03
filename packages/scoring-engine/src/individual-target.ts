import type { IndividualTargetCompetition } from '@ddga/types';
import { evaluateEligibility, type EligibilityVerdict } from './eligibility.ts';
import { standings, type StandingEntry } from './standings.ts';
import { applyRounds, type PlayerEventResult, type RoundInput } from './target.ts';

/** One player's entry into a competition: where they started and what they pulled. */
export interface IndividualTargetEntry<TPlayer> {
  readonly player: TPlayer;
  readonly startingTarget: number;
  /** Points per round, in round order. `DID_NOT_PLAY` for a round they missed. */
  readonly pointsPulled: readonly RoundInput[];
  /** Holes played per round, when the ruleset prorates and the rounds differ in length. */
  readonly holesInPlay?: readonly number[];
}

export interface IndividualTargetResult<TPlayer> {
  readonly player: TPlayer;
  readonly event: PlayerEventResult;
  readonly eligibility: EligibilityVerdict;
  /** null for a player out of the running. */
  readonly position: number | null;
  readonly tied: boolean;
}

/**
 * Score a whole field against their individual targets.
 *
 * This is composition, not new arithmetic: `applyRounds` per player, then eligibility, then
 * the ordering. It exists because the standing of one player is meaningless without the
 * others, and because the API and the leaderboard should not each assemble those three
 * pieces in their own slightly different way.
 *
 * Everything derived here is reproducible from the points alone, which is what makes the
 * results tables in the database a cache rather than a source of truth.
 */
export function runIndividualTarget<TPlayer>(
  entries: readonly IndividualTargetEntry<TPlayer>[],
  competition: IndividualTargetCompetition,
): IndividualTargetResult<TPlayer>[] {
  const scored = entries.map((entry) => {
    const event = applyRounds(entry.startingTarget, entry.pointsPulled, competition.target, {
      ...(entry.holesInPlay === undefined ? {} : { holesInPlay: entry.holesInPlay }),
    });
    return { entry, event, eligibility: evaluateEligibility(event, competition) };
  });

  const ordered: StandingEntry<TPlayer>[] = standings(
    scored.map((row) => ({
      player: row.entry.player,
      finalStanding: row.event.finalStanding,
      disqualified: !row.eligibility.eligible,
    })),
    competition,
  );

  const placings = new Map(ordered.map((row) => [row.player, row]));

  return scored.map((row) => {
    const placing = placings.get(row.entry.player);
    return {
      player: row.entry.player,
      event: row.event,
      eligibility: row.eligibility,
      position: placing?.position ?? null,
      tied: placing?.tied ?? false,
    };
  });
}

/** The field in leaderboard order, best first. */
export function orderIndividualTarget<TPlayer>(
  results: readonly IndividualTargetResult<TPlayer>[],
): IndividualTargetResult<TPlayer>[] {
  return [...results].sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    // Disqualified players keep their place in the order so a leaderboard can show where
    // they would have finished.
    if (a.position === null && b.position === null) {
      return b.event.finalStanding - a.event.finalStanding;
    }
    return b.event.finalStanding - a.event.finalStanding;
  });
}
