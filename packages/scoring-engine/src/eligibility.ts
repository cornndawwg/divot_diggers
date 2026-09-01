import type { IndividualTargetCompetition } from '@ddga/types';
import type { PlayerEventResult } from './target';

export interface EligibilityVerdict {
  /** False when this player is out of the running for this event's standings. */
  readonly eligible: boolean;
  readonly roundsPlayed: number;
  readonly roundsMissed: number;
  readonly roundsRequired: number;
  /** A disqualified player still belongs on the leaderboard, greyed — see spec 1.3. */
  readonly showOnLeaderboard: boolean;
  /** Plain English, for the leaderboard's flag. null when eligible. */
  readonly reason: string | null;
}

/**
 * Whether a player counts in the standings.
 *
 * Missing a round protects the target but forfeits the prize: a two-round cumulative cannot
 * fairly be ranked against a three-round one. These are two separate config decisions that
 * point opposite ways, which is why they are two fields.
 */
export function evaluateEligibility(
  result: PlayerEventResult,
  competition: IndividualTargetCompetition,
): EligibilityVerdict {
  const roundsRequired = competition.eligibility.minimumRoundsCompleted;
  const missedRoundsDisqualify = competition.target.didNotPlay.standing === 'disqualify';
  const shortOfRequirement = result.roundsPlayed < roundsRequired;
  const eligible = !(missedRoundsDisqualify && shortOfRequirement);

  return {
    eligible,
    roundsPlayed: result.roundsPlayed,
    roundsMissed: result.roundsMissed,
    roundsRequired,
    showOnLeaderboard: competition.target.didNotPlay.showOnLeaderboard,
    reason: eligible
      ? null
      : `Played ${result.roundsPlayed} of the ${roundsRequired} rounds required.`,
  };
}
