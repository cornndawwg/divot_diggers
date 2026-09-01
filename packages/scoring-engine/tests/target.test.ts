import { describe, expect, it } from 'vitest';
import type { Target } from '@ddga/types';
import { applyRounding, applyRound, applyRounds, initialTargetState } from '../src/index';
import { dogfightCompetition } from './fixtures';

const divotDiggers = dogfightCompetition().target;

function withTarget(overrides: Partial<Target>): Target {
  return { ...divotDiggers, ...overrides };
}

describe('rounding, stated explicitly', () => {
  // The three cases fixtures/README.md calls out as distinguishing half-up from banker's.
  it('rounds a half away from zero', () => {
    expect(applyRounding(32.5, 'half_up')).toBe(33);
    expect(applyRounding(34.5, 'half_up')).toBe(35);
    expect(applyRounding(37.5, 'half_up')).toBe(38);
  });

  it('is not banker’s rounding', () => {
    expect(applyRounding(32.5, 'half_even')).toBe(32);
    expect(applyRounding(34.5, 'half_even')).toBe(34);
    expect(applyRounding(37.5, 'half_even')).toBe(38);
    // Two of the three differ, which is the whole point of specifying the mode.
    expect(applyRounding(32.5, 'half_up')).not.toBe(applyRounding(32.5, 'half_even'));
  });

  it('leaves values that are not halves alone', () => {
    expect(applyRounding(33.4, 'half_up')).toBe(33);
    expect(applyRounding(33.6, 'half_up')).toBe(34);
  });

  it('supports the other modes the config allows', () => {
    expect(applyRounding(33.5, 'half_down')).toBe(33);
    expect(applyRounding(33.9, 'floor')).toBe(33);
    expect(applyRounding(33.1, 'ceil')).toBe(34);
  });

  it('rounds negatives away from zero for half_up', () => {
    expect(applyRounding(-33.5, 'half_up')).toBe(-34);
    expect(applyRounding(-33.5, 'half_down')).toBe(-33);
  });
});

describe('one round of the recurrence', () => {
  it('is delta against target, with half the delta folded back in', () => {
    const outcome = applyRound(initialTargetState(20), 24, divotDiggers);
    expect(outcome.roundDelta).toBe(4);
    expect(outcome.runningTotal).toBe(4);
    expect(outcome.nextTarget).toBe(22);
  });

  it('moves the target down when a player falls short', () => {
    const outcome = applyRound(initialTargetState(39), 35, divotDiggers);
    expect(outcome.roundDelta).toBe(-4);
    expect(outcome.nextTarget).toBe(37);
  });
});

describe('the config drives the behaviour, not the code', () => {
  it('stops moving the target when adjustmentFactor is 0 — a plain quota game', () => {
    const result = applyRounds(20, [24, 25, 29], withTarget({ adjustmentFactor: 0 }));
    expect(result.targetsByRound).toEqual([20, 20, 20]);
    expect(result.finalStanding).toBe(18); // 4 + 5 + 9
    expect(result.carryoverRaw).toBe(20);
  });

  it('adjusts by a quarter of the delta when the config says so', () => {
    const result = applyRounds(20, [24, 25, 29], withTarget({ adjustmentFactor: 0.25 }));
    expect(result.targetsByRound).toEqual([20, 21, 22]);
  });

  it('lets each round stand alone when runningTotal is per_round', () => {
    const result = applyRounds(20, [24, 25, 29], withTarget({ runningTotal: 'per_round' }));
    // Targets still adjust; only the standing stops accumulating.
    expect(result.targetsByRound).toEqual([20, 22, 23.5]);
    expect(result.runningTotalByRound).toEqual([4, 3, 5.5]);
    expect(result.finalStanding).toBe(5.5);
  });

  it('freezes the target mid-event when adjustBetweenRounds is off', () => {
    const result = applyRounds(20, [24, 25, 29], withTarget({ adjustBetweenRounds: false }));
    expect(result.targetsByRound).toEqual([20, 20, 20]);
    // The event-end adjustment still runs, off the last round's delta.
    expect(result.carryoverRaw).toBe(24.5);
  });

  it('leaves the carry-over untouched when adjustAtEventEnd is off', () => {
    const result = applyRounds(20, [24, 25, 29], withTarget({ adjustAtEventEnd: false }));
    expect(result.targetsByRound).toEqual([20, 22, 23.5]);
    expect(result.carryoverRaw).toBe(23.5);
  });

  it('reports when a ruleset does not carry targets between events', () => {
    expect(applyRounds(20, [24], divotDiggers).carriesAcrossEvents).toBe(true);
    expect(applyRounds(20, [24], withTarget({ carryover: 'none' })).carriesAcrossEvents).toBe(false);
  });

  it('rounds the carry-over by whatever mode the config names', () => {
    // This line of play carries over at 20.875, which the two modes resolve differently.
    const halfUp = applyRounds(20, [27, 20, 20], withTarget({ carryoverRounding: 'half_up' }));
    const floored = applyRounds(20, [27, 20, 20], withTarget({ carryoverRounding: 'floor' }));
    expect(halfUp.carryoverRaw).toBe(20.875);
    expect(floored.carryoverRaw).toBe(20.875);
    expect(halfUp.carryoverRounded).toBe(21);
    expect(floored.carryoverRounded).toBe(20);
  });
});

describe('precision is never given away mid-event', () => {
  it('keeps fractional targets through the whole recurrence', () => {
    // Kenny Adkins finished 2025 on exactly 14.375.
    const result = applyRounds(11, [18, 14, 13], divotDiggers);
    expect(result.targetsByRound.some((value) => !Number.isInteger(value))).toBe(true);
    expect(Number.isInteger(result.carryoverRaw)).toBe(false);
    expect(Number.isInteger(result.carryoverRounded)).toBe(true);
  });
});

describe('rejecting nonsense input', () => {
  it('refuses an event with no rounds', () => {
    expect(() => applyRounds(20, [], divotDiggers)).toThrow(/at least one round/i);
  });

  it('refuses a non-finite starting target', () => {
    expect(() => applyRounds(Number.NaN, [24], divotDiggers)).toThrow(/finite/i);
  });

  it('refuses non-finite points', () => {
    expect(() => applyRounds(20, [Number.POSITIVE_INFINITY], divotDiggers)).toThrow(/finite/i);
  });
});
