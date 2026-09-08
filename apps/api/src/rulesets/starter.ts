/**
 * The set of rules a brand new group starts with.
 *
 * Deliberately neutral: a points game where the target never moves and nothing carries
 * between years. It is NOT the Divot Diggers system — a new tenant should not inherit
 * another group's house rules, and every value here is meant to be edited on the Rules page.
 *
 * It exists because a group with no ruleset cannot seed a player's target, which made adding
 * the very first person to a roster fail. Something sensible and editable beats an error.
 */
export function starterRuleset(groupName: string): Record<string, unknown> {
  return {
    rulesetId: 'house-rules',
    version: 1,
    name: `${groupName} House Rules`,
    orgId: null,
    engineVersionMin: '1.0.0',
    scoringProfiles: [
      {
        id: 'points',
        name: 'Points per hole',
        basis: 'gross',
        table: [
          { relativeToPar: -3, label: 'Albatross', points: 8 },
          { relativeToPar: -2, label: 'Eagle', points: 6 },
          { relativeToPar: -1, label: 'Birdie', points: 4 },
          { relativeToPar: 0, label: 'Par', points: 2 },
          { relativeToPar: 1, label: 'Bogey', points: 1 },
        ],
        betterThanTable: { mode: 'clamp' },
        worseThanTable: { mode: 'value', points: 0 },
        specialRules: [],
        pickup: { policy: 'cap_at_first_zero', fixedRelativeToPar: null, recordCappedStrokes: true },
      },
    ],
    competitions: [
      {
        id: 'main',
        name: 'Main competition',
        type: 'individual_target',
        scoringProfile: 'points',
        rounds: ['thu-am', 'fri-am', 'sat-am'],
        target: {
          label: 'Target',
          abbreviation: 'TGT',
          initialValue: {
            method: 'constant_minus_handicap',
            constant: 36,
            handicapSource: 'handicap_index',
            rounding: 'half_up',
          },
          carryover: 'none',
          carryoverRounding: 'half_up',
          adjustmentFactor: 0,
          adjustBetweenRounds: false,
          adjustAtEventEnd: false,
          runningTotal: 'cumulative',
          precision: 'full',
          displayPrecision: 0,
          prorateByHoles: false,
          holesPerFullRound: 18,
          didNotPlay: { ptp: 'freeze', standing: 'include', showOnLeaderboard: true },
          lapsedPlayer: {
            method: 'carry_unchanged',
            requirePlannerConfirmation: true,
            maxAdjustment: null,
            plannerMayEditSuggestion: true,
          },
        },
        eligibility: { minimumRoundsCompleted: 1 },
        standings: { sortBy: 'running_total', direction: 'desc' },
        tiebreak: { chain: [], fallback: { mode: 'planner_resolved', label: 'Playoff' } },
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
}
