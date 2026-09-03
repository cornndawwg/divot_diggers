import type { Target } from '@ddga/types';
import { ScoringInputError } from './errors.ts';
import { applyRounding } from './rounding.ts';

/** Where a player stands part-way through an event. */
export interface TargetState {
  /** The target this player plays against on the next round. */
  readonly target: number;
  /** The standing carried into the next round. */
  readonly runningTotal: number;
}

/**
 * A round a player missed. The target is a long-lived asset and a player who had to leave
 * early should not have it damaged, so by default a missed round freezes it — see spec 1.3.
 */
export const DID_NOT_PLAY = null;

/** Points pulled in a round, or `DID_NOT_PLAY` for a round the player missed. */
export type RoundInput = number | typeof DID_NOT_PLAY;

/** What one round did to a player's target and standing. */
export interface RoundOutcome {
  /** The player's standing target, before any proration for a short round. */
  readonly target: number;
  /**
   * The target actually played against. Equal to `target` unless the round was shorter than
   * a full round and the ruleset prorates.
   */
  readonly effectiveTarget: number;
  /** Holes played in this round, or null when the caller did not say. */
  readonly holesInPlay: number | null;
  readonly didNotPlay: boolean;
  /** null for a missed round. A missed round is unscored, not scored as zero. */
  readonly pointsPulled: number | null;
  /** Points above or below the target for this round alone. null for a missed round. */
  readonly roundDelta: number | null;
  /** The standing after this round, cumulative or per-round as the config says. */
  readonly runningTotal: number;
  /** The target after adjustment. Unchanged when adjustment is switched off. */
  readonly nextTarget: number;
  readonly next: TargetState;
}

export interface PlayerEventResult {
  readonly rounds: readonly RoundOutcome[];
  /** The target in force at the start of each round, in order. */
  readonly targetsByRound: readonly number[];
  /** The standing after each round, in order. */
  readonly runningTotalByRound: readonly number[];
  /** The standing once every round is in. */
  readonly finalStanding: number;
  readonly roundsPlayed: number;
  readonly roundsMissed: number;
  /** The target after the event, at full precision. Never rounded here — invariant #2. */
  readonly carryoverRaw: number;
  /** The whole number that seeds the next event, rounded as the config specifies. */
  readonly carryoverRounded: number;
  /** False when the ruleset starts every event from scratch. */
  readonly carriesAcrossEvents: boolean;
}

export function initialTargetState(startingTarget: number): TargetState {
  assertFinite(startingTarget, 'startingTarget');
  return { target: startingTarget, runningTotal: 0 };
}

function assertFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScoringInputError(`${label} must be a finite number, received ${String(value)}.`);
  }
}

export interface ApplyRoundOptions {
  /**
   * Whether this is the last round of the event. The two adjustment switches govern different
   * moments: `adjustBetweenRounds` between rounds, `adjustAtEventEnd` on the way out.
   */
  readonly isFinalRound?: boolean;
  /**
   * Holes played in this round, from the round's resolved hole selection. Only used when the
   * ruleset sets `prorateByHoles`; omit it and the full target applies.
   */
  readonly holesInPlay?: number;
}

/**
 * The target to play against for a round of this length.
 *
 * A target calibrated over 18 holes is not a fair expectation over 9, so a ruleset can scale
 * it by the fraction of a round actually played. Both the switch and the denominator are
 * config: nothing here knows that a round is usually 18 holes.
 */
export function effectiveTargetFor(
  target: number,
  config: Target,
  holesInPlay?: number,
): number {
  if (!config.prorateByHoles || holesInPlay === undefined) return target;
  if (!Number.isFinite(holesInPlay) || holesInPlay <= 0) {
    throw new ScoringInputError(
      `holesInPlay must be a positive number, received ${String(holesInPlay)}.`,
    );
  }
  if (holesInPlay === config.holesPerFullRound) return target;
  // Full precision, as everywhere in the recurrence — invariant #2.
  return (target * holesInPlay) / config.holesPerFullRound;
}

/**
 * One round of the recurrence:
 *
 *   roundDelta = pulled − target
 *   runningTotal = previous + roundDelta   (or just roundDelta, per config)
 *   nextTarget = target + adjustmentFactor × roundDelta
 *
 * Every parameter comes from the ruleset. Set `adjustmentFactor` to 0 and the target stops
 * moving, which is a plain quota game; set `runningTotal` to `per_round` and each day stands
 * alone. Nothing is rounded.
 */
export function applyRound(
  state: TargetState,
  pointsPulled: RoundInput,
  config: Target,
  options: ApplyRoundOptions = {},
): RoundOutcome {
  assertFinite(state.target, 'target');
  assertFinite(state.runningTotal, 'runningTotal');

  if (pointsPulled === DID_NOT_PLAY && config.didNotPlay.ptp === 'freeze') {
    return {
      target: state.target,
      effectiveTarget: state.target,
      holesInPlay: options.holesInPlay ?? null,
      didNotPlay: true,
      pointsPulled: null,
      roundDelta: null,
      runningTotal: state.runningTotal,
      nextTarget: state.target,
      next: state,
    };
  }

  const scored = pointsPulled === DID_NOT_PLAY ? 0 : pointsPulled;
  assertFinite(scored, 'pointsPulled');

  const effectiveTarget = effectiveTargetFor(state.target, config, options.holesInPlay);
  const roundDelta = scored - effectiveTarget;

  const runningTotal =
    config.runningTotal === 'cumulative' ? state.runningTotal + roundDelta : roundDelta;

  const adjustmentApplies =
    options.isFinalRound === true ? config.adjustAtEventEnd : config.adjustBetweenRounds;

  const nextTarget = adjustmentApplies
    ? state.target + config.adjustmentFactor * roundDelta
    : state.target;

  return {
    target: state.target,
    effectiveTarget,
    holesInPlay: options.holesInPlay ?? null,
    didNotPlay: pointsPulled === DID_NOT_PLAY,
    pointsPulled: scored,
    roundDelta,
    runningTotal,
    nextTarget,
    next: { target: nextTarget, runningTotal },
  };
}

/** Run a player's whole event, from their starting target through to their carry-over value. */
export function applyRounds(
  startingTarget: number,
  pointsPulled: readonly RoundInput[],
  config: Target,
): PlayerEventResult {
  if (pointsPulled.length === 0) {
    throw new ScoringInputError('A player event needs at least one round of points.');
  }

  let state = initialTargetState(startingTarget);
  const rounds: RoundOutcome[] = [];

  pointsPulled.forEach((pulled, index) => {
    const outcome = applyRound(state, pulled, config, {
      isFinalRound: index === pointsPulled.length - 1,
    });
    rounds.push(outcome);
    state = outcome.next;
  });

  const lastRound = rounds[rounds.length - 1];
  if (lastRound === undefined) throw new ScoringInputError('No rounds were applied.');

  return {
    rounds,
    targetsByRound: rounds.map((round) => round.target),
    runningTotalByRound: rounds.map((round) => round.runningTotal),
    finalStanding: lastRound.runningTotal,
    roundsPlayed: rounds.filter((round) => !round.didNotPlay).length,
    roundsMissed: rounds.filter((round) => round.didNotPlay).length,
    carryoverRaw: state.target,
    carryoverRounded: applyRounding(state.target, config.carryoverRounding),
    carriesAcrossEvents: config.carryover === 'across_events',
  };
}
