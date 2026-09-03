import { z } from 'zod';
import {
  identifierSchema,
  individualPayoutSchema,
  plannerResolvedFallbackSchema,
  roundingModeSchema,
  teamPayoutSchema,
} from './common.ts';

// ---------------------------------------------------------------------------
// individual_target — the Divot Diggers dogfight, quota games, Stableford
// ---------------------------------------------------------------------------

/** How a player who has never played before gets their first target. */
export const initialTargetValueSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('constant_minus_handicap'),
    constant: z.number(),
    /** Index, not course handicap — see spec 1.3a. The field exists for groups that differ. */
    handicapSource: z.enum(['handicap_index', 'course_handicap']),
    rounding: roundingModeSchema,
  }),
  z.strictObject({ method: z.literal('fixed'), value: z.number() }),
  z.strictObject({ method: z.literal('manual') }),
]);

export const targetSchema = z.strictObject({
  label: z.string().min(1),
  abbreviation: z.string().min(1),
  initialValue: initialTargetValueSchema,
  carryover: z.enum(['across_events', 'none']),
  /** Applied only at year end. In-trip values stay fractional — invariant #2. */
  carryoverRounding: roundingModeSchema,
  /** Fraction of each round's delta folded back into the target. 0 gives a plain quota game. */
  adjustmentFactor: z.number().min(0).max(1),
  adjustBetweenRounds: z.boolean(),
  adjustAtEventEnd: z.boolean(),
  runningTotal: z.enum(['cumulative', 'per_round']),
  /** Intermediate values are never rounded, so this is the only supported mode. */
  precision: z.literal('full'),
  /** Decimal places at the display layer only. */
  displayPrecision: z.number().int().min(0).max(6),
  prorateByHoles: z.boolean(),
  /**
   * How many holes the target is calibrated over — the denominator for proration.
   *
   * Never assume 18. The Divot Diggers dogfight is always 18 and their Cup always 9, but that
   * is their arrangement, not a rule: a group whose rounds are all nines has a target
   * calibrated over 9 and needs no proration at all. The default is 18 because it is the
   * common case, not because the engine knows anything about golf.
   */
  holesPerFullRound: z.number().int().min(1).max(36).default(18),
  /**
   * Two separate decisions that point opposite ways: missing a round protects the rating but
   * forfeits the prize. See spec 1.3.
   */
  didNotPlay: z.strictObject({
    ptp: z.enum(['freeze', 'score_as_zero']),
    standing: z.enum(['disqualify', 'include']),
    showOnLeaderboard: z.boolean(),
  }),
  lapsedPlayer: z.strictObject({
    method: z.enum(['carry_with_handicap_delta', 'carry_unchanged', 'manual']),
    requirePlannerConfirmation: z.boolean(),
    /** null = uncapped. The planner confirms every suggestion regardless. */
    maxAdjustment: z.number().min(0).nullable(),
    plannerMayEditSuggestion: z.boolean(),
  }),
});

export const individualTiebreakRuleSchema = z.enum([
  'last_round_delta',
  'best_single_round',
  'lowest_handicap',
  'countback_final_nine',
]);

export const individualTargetCompetitionSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1),
  type: z.literal('individual_target'),
  scoringProfile: identifierSchema,
  rounds: z.array(identifierSchema).min(1, 'A competition needs at least one round.'),
  target: targetSchema,
  eligibility: z.strictObject({
    minimumRoundsCompleted: z.number().int().min(0),
  }),
  standings: z.strictObject({
    sortBy: z.literal('running_total'),
    direction: z.enum(['asc', 'desc']),
  }),
  tiebreak: z.strictObject({
    chain: z.array(individualTiebreakRuleSchema),
    fallback: plannerResolvedFallbackSchema,
  }),
  payouts: z.array(individualPayoutSchema).default([]),
});

// ---------------------------------------------------------------------------
// team_match_play — the Winona Ryder Cup and the Ryder Cup family generally
// ---------------------------------------------------------------------------

export const matchPlaySessionSchema = z.strictObject({
  roundId: identifierSchema,
  format: z.enum(['scramble', 'alternate_shot', 'singles', 'four_ball']),
  playersPerSide: z.number().int().min(1),
  matches: z.number().int().min(1),
  holes: z.number().int().min(1).max(18),
});

export const teamMatchPlayCompetitionSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1),
  type: z.literal('team_match_play'),
  /** Match play compares strokes hole by hole; it never references a points table. Spec 1.3b. */
  holeComparison: z.enum(['gross_strokes', 'net_strokes']),
  handicapAllowance: z.number().min(0).max(1),
  matchPlay: z.strictObject({
    concessions: z.strictObject({
      hole: z.strictObject({ byOpponent: z.boolean(), bySelf: z.boolean() }),
      stroke: z.strictObject({ byOpponent: z.boolean() }),
      /** A conceded hole is genuinely unscored, not scored as a zero. */
      recordStrokes: z.boolean(),
    }),
    pickupPolicy: z.literal('not_applicable'),
    closeOutWhenDecided: z.boolean(),
    statusFormat: z.literal('holes_up_thru'),
  }),
  teams: z
    .array(z.strictObject({ id: identifierSchema, name: z.string().min(1) }))
    .length(2, 'Match play is played between exactly two sides, so teams must contain two entries.'),
  rosterSelection: z.strictObject({
    method: z.enum(['captain_draft', 'manual']),
    order: z.enum(['snake', 'linear']),
    pickTimerSeconds: z.number().int().min(1).nullable(),
  }),
  pointsPerMatch: z.strictObject({
    win: z.number().positive(),
    halved: z.number().min(0),
    loss: z.number().min(0),
  }),
  sessions: z.array(matchPlaySessionSchema).min(1, 'A cup needs at least one session.'),
  /** Derived and validated against the sessions, never merely trusted. Spec 1.3. */
  totalPointsAvailable: z.number().positive(),
  clinchThreshold: z.number().positive(),
  matchupMethod: z.literal('captain_pick'),
  matchupLock: z.enum(['night_before', 'session_start']),
  tiebreak: z.strictObject({
    chain: z.array(z.enum(['captains_playoff'])),
    fallback: plannerResolvedFallbackSchema,
  }),
  payouts: z.array(teamPayoutSchema).default([]),
});

export const competitionSchema = z.discriminatedUnion('type', [
  individualTargetCompetitionSchema,
  teamMatchPlayCompetitionSchema,
]);

export type Target = z.infer<typeof targetSchema>;
export type MatchPlaySession = z.infer<typeof matchPlaySessionSchema>;
export type IndividualTargetCompetition = z.infer<typeof individualTargetCompetitionSchema>;
export type TeamMatchPlayCompetition = z.infer<typeof teamMatchPlayCompetitionSchema>;
export type Competition = z.infer<typeof competitionSchema>;
