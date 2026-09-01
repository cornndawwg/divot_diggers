import { describe, expect, it } from 'vitest';
import type { IndividualTargetCompetition, Target } from '@ddga/types';
import {
  DID_NOT_PLAY,
  applyRounds,
  evaluateEligibility,
  standings,
  suggestLapsedPlayerPtp,
} from '../src/index';
import { dogfightCompetition } from './fixtures';

const competition = dogfightCompetition();
const divotDiggers = competition.target;

function withTarget(overrides: Partial<Target>): Target {
  return { ...divotDiggers, ...overrides };
}

function withCompetition(target: Target): IndividualTargetCompetition {
  return { ...competition, target };
}

describe('a missed round freezes the target', () => {
  it('leaves the target exactly where it was', () => {
    const result = applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers);
    // 20 -> 22 after round 1, frozen through round 2, still 22 for round 3.
    expect(result.targetsByRound).toEqual([20, 22, 22]);
  });

  it('contributes nothing to the standing', () => {
    const result = applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers);
    expect(result.runningTotalByRound).toEqual([4, 4, 11]);
    expect(result.finalStanding).toBe(11);
  });

  it('records the round as unscored rather than as a zero', () => {
    const result = applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers);
    const missed = result.rounds[1];
    expect(missed?.didNotPlay).toBe(true);
    expect(missed?.pointsPulled).toBeNull();
    expect(missed?.roundDelta).toBeNull();
  });

  it('counts rounds played and missed', () => {
    const result = applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers);
    expect(result.roundsPlayed).toBe(2);
    expect(result.roundsMissed).toBe(1);
  });

  it('protects the carry-over value too', () => {
    const played = applyRounds(20, [24, 29], divotDiggers);
    const missedFirst = applyRounds(20, [DID_NOT_PLAY, 24, 29], divotDiggers);
    expect(missedFirst.carryoverRaw).toBe(played.carryoverRaw);
  });

  it('can be scored as a zero instead, when a ruleset says so', () => {
    const config = withTarget({
      didNotPlay: { ...divotDiggers.didNotPlay, ptp: 'score_as_zero' },
    });
    const result = applyRounds(20, [DID_NOT_PLAY], config);
    expect(result.rounds[0]?.pointsPulled).toBe(0);
    expect(result.finalStanding).toBe(-20);
  });
});

describe('missing a round forfeits the prize', () => {
  it('disqualifies a player short of the required rounds', () => {
    const result = applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers);
    const verdict = evaluateEligibility(result, competition);

    expect(verdict.eligible).toBe(false);
    expect(verdict.roundsPlayed).toBe(2);
    expect(verdict.roundsRequired).toBe(3);
    expect(verdict.reason).toBe('Played 2 of the 3 rounds required.');
  });

  it('keeps a full-attendance player eligible', () => {
    const verdict = evaluateEligibility(applyRounds(20, [24, 25, 29], divotDiggers), competition);
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('still shows them on the leaderboard', () => {
    const verdict = evaluateEligibility(
      applyRounds(20, [24, DID_NOT_PLAY, 29], divotDiggers),
      competition,
    );
    expect(verdict.showOnLeaderboard).toBe(true);
  });

  it('lets a ruleset rank part-timers anyway', () => {
    const lenient = withTarget({
      didNotPlay: { ...divotDiggers.didNotPlay, standing: 'include' },
    });
    const verdict = evaluateEligibility(
      applyRounds(20, [24, DID_NOT_PLAY, 29], lenient),
      withCompetition(lenient),
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('a disqualified player on the leaderboard', () => {
  const field = [
    { player: 'Played all three', finalStanding: 10 },
    { player: 'Missed one', finalStanding: 12, disqualified: true },
    { player: 'Also played all three', finalStanding: 8 },
  ];

  it('appears where they would have finished', () => {
    const table = standings(field, competition);
    expect(table.map((entry) => entry.player)).toEqual([
      'Missed one',
      'Played all three',
      'Also played all three',
    ]);
  });

  it('holds no position, so the eligible field is numbered 1 and 2', () => {
    const table = standings(field, competition);
    expect(table.map((entry) => entry.position)).toEqual([null, 1, 2]);
  });

  it('is flagged rather than hidden', () => {
    const table = standings(field, competition);
    expect(table[0]?.disqualified).toBe(true);
    expect(table[0]?.finalStanding).toBe(12);
  });

  it('does not create a tie with an eligible player on the same number', () => {
    const table = standings(
      [
        { player: 'Eligible', finalStanding: 6 },
        { player: 'Disqualified', finalStanding: 6, disqualified: true },
      ],
      competition,
    );
    expect(table.every((entry) => !entry.tied)).toBe(true);
  });
});

describe('a player coming back after a gap', () => {
  it('raises the target for a player who improved', () => {
    const suggestion = suggestLapsedPlayerPtp(
      {
        lastPtp: 24,
        handicapIndexAtLastAppearance: 30,
        currentHandicapIndex: 27,
        eventsMissed: 2,
      },
      divotDiggers,
    );

    expect(suggestion.handicapDelta).toBe(-3);
    expect(suggestion.adjustment).toBe(3);
    expect(suggestion.suggestedPtp).toBe(27);
  });

  it('lowers the target for a player who got worse', () => {
    const suggestion = suggestLapsedPlayerPtp(
      {
        lastPtp: 24,
        handicapIndexAtLastAppearance: 20,
        currentHandicapIndex: 24.5,
        eventsMissed: 1,
      },
      divotDiggers,
    );

    expect(suggestion.adjustment).toBe(-4.5);
    expect(suggestion.suggestedPtpRaw).toBe(19.5);
    expect(suggestion.suggestedPtp).toBe(20); // half up
  });

  it('is a suggestion the planner has to confirm', () => {
    const suggestion = suggestLapsedPlayerPtp(
      { lastPtp: 24, handicapIndexAtLastAppearance: 30, currentHandicapIndex: 27, eventsMissed: 2 },
      divotDiggers,
    );
    expect(suggestion.requiresPlannerConfirmation).toBe(true);
    expect(suggestion.plannerMayEditSuggestion).toBe(true);
  });

  it('is uncapped by default but respects a cap when one is set', () => {
    const input = {
      lastPtp: 24,
      handicapIndexAtLastAppearance: 30,
      currentHandicapIndex: 18,
      eventsMissed: 3,
    };

    const uncapped = suggestLapsedPlayerPtp(input, divotDiggers);
    expect(uncapped.adjustment).toBe(12);
    expect(uncapped.cappedAt).toBeNull();

    const capped = suggestLapsedPlayerPtp(
      input,
      withTarget({ lapsedPlayer: { ...divotDiggers.lapsedPlayer, maxAdjustment: 5 } }),
    );
    expect(capped.rawAdjustment).toBe(12);
    expect(capped.adjustment).toBe(5);
    expect(capped.cappedAt).toBe(5);
    expect(capped.suggestedPtp).toBe(29);
  });

  it('carries the target unchanged when the ruleset says to', () => {
    const suggestion = suggestLapsedPlayerPtp(
      { lastPtp: 24, handicapIndexAtLastAppearance: 30, currentHandicapIndex: 27, eventsMissed: 2 },
      withTarget({ lapsedPlayer: { ...divotDiggers.lapsedPlayer, method: 'carry_unchanged' } }),
    );
    expect(suggestion.adjustment).toBe(0);
    expect(suggestion.suggestedPtp).toBe(24);
  });

  it('explains itself in a sentence the planner can read', () => {
    const suggestion = suggestLapsedPlayerPtp(
      { lastPtp: 24, handicapIndexAtLastAppearance: 30, currentHandicapIndex: 27, eventsMissed: 2 },
      divotDiggers,
    );
    expect(suggestion.explanation).toBe(
      'Returning after missing 2 events on a target of 24, now 3 strokes better than at their ' +
        'last appearance, so the target moves up by 3 to 27. The planner confirms this.',
    );
  });
});
