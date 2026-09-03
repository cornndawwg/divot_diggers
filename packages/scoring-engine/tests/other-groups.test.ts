import { describe, expect, it } from 'vitest';
import { parseRuleset, type IndividualTargetCompetition } from '@ddga/types';
import { applyRound, applyRounds, holePoints, initialTargetState, standings } from '../src/index.ts';

/**
 * A third group's rules, sharing nothing with the Divot Diggers.
 *
 * The point of this file is the claim that no tenant is forced into another tenant's
 * methodology: game type, hole count, point values and target behaviour are all config. If
 * this needed a single change to engine source, that claim would be false.
 *
 * This group plays a quota game over nines: par is worth 5, the target never moves, each day
 * stands alone, and everyone is eligible after one round.
 */
const OTHER_GROUP = {
  rulesetId: 'sunday-nine',
  version: 1,
  name: 'Sunday Nine Quota',
  orgId: 'sunday-league',
  engineVersionMin: '1.0.0',
  scoringProfiles: [
    {
      id: 'generous',
      name: 'Generous Points',
      basis: 'gross',
      table: [
        { relativeToPar: -2, label: 'Eagle', points: 12 },
        { relativeToPar: -1, label: 'Birdie', points: 8 },
        // Par is worth 5 here, not 3.
        { relativeToPar: 0, label: 'Par', points: 5 },
        { relativeToPar: 1, label: 'Bogey', points: 3 },
        { relativeToPar: 2, label: 'Double Bogey', points: 1 },
      ],
      betterThanTable: { mode: 'clamp' },
      worseThanTable: { mode: 'value', points: 0 },
      specialRules: [
        {
          id: 'hole_in_one',
          label: 'Ace',
          enabled: true,
          trigger: { strokes: 1 },
          effect: { mode: 'add', points: 10 },
        },
      ],
      pickup: { policy: 'cap_at_first_zero', fixedRelativeToPar: null, recordCappedStrokes: true },
    },
  ],
  competitions: [
    {
      id: 'quota',
      name: 'Sunday Quota',
      type: 'individual_target',
      scoringProfile: 'generous',
      rounds: ['sun-am'],
      target: {
        label: 'Quota',
        abbreviation: 'Q',
        initialValue: { method: 'fixed', value: 30 },
        carryover: 'none',
        carryoverRounding: 'half_up',
        adjustmentFactor: 0,
        adjustBetweenRounds: false,
        adjustAtEventEnd: false,
        runningTotal: 'per_round',
        precision: 'full',
        displayPrecision: 0,
        prorateByHoles: true,
        // Their full round is nine holes, not eighteen.
        holesPerFullRound: 9,
        didNotPlay: { ptp: 'freeze', standing: 'include', showOnLeaderboard: true },
        lapsedPlayer: {
          method: 'carry_unchanged',
          requirePlannerConfirmation: false,
          maxAdjustment: null,
          plannerMayEditSuggestion: true,
        },
      },
      eligibility: { minimumRoundsCompleted: 1 },
      standings: { sortBy: 'running_total', direction: 'desc' },
      tiebreak: { chain: [], fallback: { mode: 'planner_resolved', label: 'Nearest the pin' } },
      payouts: [],
    },
  ],
  validation: {
    assertSessionMatchesSumToTotal: true,
    assertClinchExceedsHalfOfTotal: true,
    assertAllReferencedRoundsExist: true,
    assertAllReferencedProfilesExist: true,
  },
};

const ruleset = parseRuleset(OTHER_GROUP);
const profile = ruleset.scoringProfiles[0];
const competition = ruleset.competitions[0] as IndividualTargetCompetition;

describe('a third group, on the same engine', () => {
  it('validates against the same schema', () => {
    expect(ruleset.name).toBe('Sunday Nine Quota');
    expect(competition.type).toBe('individual_target');
  });

  it('scores a par as 5 points, because that is what its table says', () => {
    if (profile === undefined) throw new Error('no profile');
    expect(holePoints(4, 4, profile)).toBe(5);
    expect(holePoints(3, 4, profile)).toBe(8);
    expect(holePoints(2, 4, profile)).toBe(12);
    expect(holePoints(5, 4, profile)).toBe(3);
    expect(holePoints(7, 4, profile)).toBe(0);
  });

  it('stacks its ace bonus on top of the table instead of replacing it', () => {
    if (profile === undefined) throw new Error('no profile');
    // A 1 on a par 3 is an eagle here: 12 + the 10 point bonus.
    expect(holePoints(1, 3, profile)).toBe(22);
  });

  it('treats nine holes as a full round, so nothing is prorated', () => {
    const outcome = applyRound(initialTargetState(30), 34, competition.target, {
      holesInPlay: 9,
    });
    expect(outcome.effectiveTarget).toBe(30);
    expect(outcome.roundDelta).toBe(4);
  });

  it('never moves the quota, and never carries it to next week', () => {
    const result = applyRounds(30, [34, 28], competition.target);
    expect(result.targetsByRound).toEqual([30, 30]);
    expect(result.carriesAcrossEvents).toBe(false);
    // Each round stands alone, so the standing is the last round's delta.
    expect(result.runningTotalByRound).toEqual([4, -2]);
    expect(result.finalStanding).toBe(-2);
  });

  it('ranks a one-round player, where the Divot Diggers would disqualify them', () => {
    const table = standings([{ player: 'One round only', finalStanding: 4 }], competition);
    expect(table[0]?.disqualified).toBe(false);
    expect(table[0]?.position).toBe(1);
  });
});
