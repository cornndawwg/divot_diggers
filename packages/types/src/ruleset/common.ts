import { z } from 'zod';

/**
 * How a fractional value becomes a whole one.
 *
 * The engine must implement every mode explicitly. Never delegate to a language or library
 * default — see invariant #3 in CLAUDE.md. `half_up` (33.5 -> 34) is the Divot Diggers mode and
 * the one the golden fixtures are built on; `half_even` is what most defaults silently do and
 * would be wrong for roughly a quarter of the field.
 */
export const roundingModeSchema = z.enum([
  'half_up',
  'half_down',
  'half_even',
  'floor',
  'ceil',
]);

/** `major.minor.patch` — the minimum engine version a ruleset needs. */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Expected a version like "1.0.0".');

export const identifierSchema = z
  .string()
  .min(1, 'An id cannot be empty.')
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'An id may contain only letters, numbers, "-" and "_".');

/**
 * A tie the app resolves off-app. The engine's job is to detect the tie, name the method, and
 * record the outcome — not to adjudicate it. See spec 1.3.
 */
export const plannerResolvedFallbackSchema = z.strictObject({
  mode: z.literal('planner_resolved'),
  label: z.string().min(1),
});

export const individualPayoutSchema = z.strictObject({
  place: z.number().int().min(1),
  amount: z.number().min(0),
});

export const teamPayoutSchema = z.strictObject({
  place: z.number().int().min(1),
  amount: z.number().min(0),
  split: z.enum(['per_team', 'per_player']),
});

export type RoundingMode = z.infer<typeof roundingModeSchema>;
