import type { Target } from '@ddga/types';
import { ScoringInputError } from './errors.ts';
import { applyRounding } from './rounding.ts';

export interface LapsedPlayerInput {
  /** The target they carried out of their last appearance. */
  readonly lastPtp: number;
  readonly handicapIndexAtLastAppearance: number;
  readonly currentHandicapIndex: number;
  /** How many events they have missed since. Reported back for the planner's context. */
  readonly eventsMissed: number;
}

export interface LapsedPlayerSuggestion {
  readonly method: Target['lapsedPlayer']['method'];
  readonly lastPtp: number;
  readonly eventsMissed: number;
  /** Current index minus the index at their last appearance. Negative means they improved. */
  readonly handicapDelta: number;
  /** The adjustment before any cap. Positive raises the target. */
  readonly rawAdjustment: number;
  /** The adjustment actually suggested, after `maxAdjustment`. */
  readonly adjustment: number;
  /** The cap that bit, or null if none did. */
  readonly cappedAt: number | null;
  readonly suggestedPtpRaw: number;
  readonly suggestedPtp: number;
  readonly requiresPlannerConfirmation: boolean;
  readonly plannerMayEditSuggestion: boolean;
  /** A sentence the reconciliation screen can show verbatim. */
  readonly explanation: string;
}

/**
 * What to seed a returning player's target with.
 *
 * This is a judgment call, not a formula, so the engine only ever produces a suggestion. PTP
 * runs inversely to handicap — a player who improved by 3 strokes gets 3 added to their target
 * — but how much of a multi-year absence that really accounts for is a human decision. The
 * planner confirms every one.
 */
export function suggestLapsedPlayerPtp(
  input: LapsedPlayerInput,
  config: Target,
): LapsedPlayerSuggestion {
  for (const [label, value] of [
    ['lastPtp', input.lastPtp],
    ['handicapIndexAtLastAppearance', input.handicapIndexAtLastAppearance],
    ['currentHandicapIndex', input.currentHandicapIndex],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new ScoringInputError(`${label} must be a finite number, received ${String(value)}.`);
    }
  }

  const { method, maxAdjustment, requirePlannerConfirmation, plannerMayEditSuggestion } =
    config.lapsedPlayer;

  const handicapDelta = input.currentHandicapIndex - input.handicapIndexAtLastAppearance;
  const rawAdjustment = method === 'carry_with_handicap_delta' ? -handicapDelta : 0;

  const capBit = maxAdjustment !== null && Math.abs(rawAdjustment) > maxAdjustment;
  const adjustment = capBit ? Math.sign(rawAdjustment) * maxAdjustment : rawAdjustment;

  const suggestedPtpRaw = input.lastPtp + adjustment;
  const suggestedPtp = applyRounding(suggestedPtpRaw, config.carryoverRounding);

  return {
    method,
    lastPtp: input.lastPtp,
    eventsMissed: input.eventsMissed,
    handicapDelta,
    rawAdjustment,
    adjustment,
    cappedAt: capBit ? maxAdjustment : null,
    suggestedPtpRaw,
    suggestedPtp,
    requiresPlannerConfirmation: requirePlannerConfirmation,
    plannerMayEditSuggestion,
    explanation: explain(input, method, handicapDelta, adjustment, suggestedPtp, capBit),
  };
}

function explain(
  input: LapsedPlayerInput,
  method: Target['lapsedPlayer']['method'],
  handicapDelta: number,
  adjustment: number,
  suggestedPtp: number,
  capped: boolean,
): string {
  const absence =
    input.eventsMissed === 1 ? 'after missing one event' : `after missing ${input.eventsMissed} events`;

  if (method === 'manual') {
    return `Returning ${absence} on a target of ${input.lastPtp}. This ruleset asks the planner to set the new target by hand.`;
  }

  if (method === 'carry_unchanged' || adjustment === 0) {
    return `Returning ${absence} on a target of ${input.lastPtp}, with no handicap movement to account for, so the target carries unchanged.`;
  }

  const movement =
    handicapDelta < 0
      ? `${Math.abs(handicapDelta)} strokes better`
      : `${Math.abs(handicapDelta)} strokes worse`;
  const direction = adjustment > 0 ? 'up' : 'down';
  const cap = capped ? ', capped by the ruleset' : '';

  return `Returning ${absence} on a target of ${input.lastPtp}, now ${movement} than at their last appearance, so the target moves ${direction} by ${Math.abs(adjustment)}${cap} to ${suggestedPtp}. The planner confirms this.`;
}
