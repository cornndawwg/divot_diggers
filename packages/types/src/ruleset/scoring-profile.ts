import { z } from 'zod';
import { identifierSchema } from './common';

/**
 * One row of the points table. Fully CRUD — a planner adds, edits and deletes rows, and the
 * engine reads whatever rows exist. Nothing about "birdie = 5" is known to the code.
 */
export const pointsTableRowSchema = z.strictObject({
  relativeToPar: z.number().int(),
  label: z.string().min(1),
  points: z.number(),
});

/**
 * What happens to a score better than the best row, or worse than the worst row.
 * `clamp` reuses the boundary row's value; `value` substitutes a flat number.
 */
export const tableBoundarySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('clamp') }),
  z.strictObject({ mode: z.literal('value'), points: z.number() }),
]);

/**
 * An override layer above the table, for rules that key off something other than the
 * score-to-par relationship — an ace being the obvious one, since the table cannot see it.
 * Evaluated after the table produces a base value, in array order.
 */
export const specialRuleSchema = z.strictObject({
  id: identifierSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  trigger: z.strictObject({
    strokes: z.number().int().min(1),
  }),
  effect: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('override'), points: z.number() }),
    z.strictObject({ mode: z.literal('add'), points: z.number() }),
  ]),
  plannerEditable: z.boolean().default(true),
});

export const pickupSchema = z.strictObject({
  policy: z.enum(['cap_at_first_zero', 'cap_at_fixed', 'play_out']).default('cap_at_first_zero'),
  /** Only meaningful when policy is `cap_at_fixed`. */
  fixedRelativeToPar: z.number().int().nullable().default(null),
  /** Write the capped score onto the card rather than leaving the hole blank. */
  recordCappedStrokes: z.boolean().default(true),
});

export const handicapAllocationSchema = z.strictObject({
  source: z.enum(['handicap_index', 'course_handicap']),
  allowance: z.number().min(0).max(2),
  method: z.enum(['stroke_index']),
});

const scoringProfileShape = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1),
  basis: z.enum(['gross', 'net']),
  table: z.array(pointsTableRowSchema).min(1, 'A points table needs at least one row.'),
  betterThanTable: tableBoundarySchema,
  worseThanTable: tableBoundarySchema,
  specialRules: z.array(specialRuleSchema).default([]),
  pickup: pickupSchema,
  /** Required when basis is `net`, forbidden when basis is `gross`. */
  handicapAllocation: handicapAllocationSchema.optional(),
});

export const scoringProfileSchema = scoringProfileShape.superRefine((profile, ctx) => {
  const seenRelativeToPar = new Set<number>();
  profile.table.forEach((row, index) => {
    if (seenRelativeToPar.has(row.relativeToPar)) {
      ctx.addIssue({
        code: 'custom',
        path: ['table', index, 'relativeToPar'],
        message: `Two rows both score ${row.relativeToPar} relative to par. Each value may appear only once.`,
      });
    }
    seenRelativeToPar.add(row.relativeToPar);
  });

  const seenRuleIds = new Set<string>();
  profile.specialRules.forEach((rule, index) => {
    if (seenRuleIds.has(rule.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['specialRules', index, 'id'],
        message: `Duplicate special rule id "${rule.id}".`,
      });
    }
    seenRuleIds.add(rule.id);
  });

  const { policy, fixedRelativeToPar } = profile.pickup;

  if (policy === 'cap_at_fixed' && fixedRelativeToPar === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['pickup', 'fixedRelativeToPar'],
      message:
        'pickup.policy is "cap_at_fixed" but fixedRelativeToPar is not set, so there is no cap to apply.',
    });
  }

  if (policy !== 'cap_at_fixed' && fixedRelativeToPar !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['pickup', 'fixedRelativeToPar'],
      message: `fixedRelativeToPar only applies when pickup.policy is "cap_at_fixed", but the policy here is "${policy}".`,
    });
  }

  if (policy === 'cap_at_first_zero') {
    // The cap is derived from the table rather than hardcoded (spec 1.2b), so the table has to
    // actually reach zero somewhere or there is no boundary to derive.
    const aRowScoresZero = profile.table.some((row) => row.points === 0);
    const worseThanTableIsZero =
      profile.worseThanTable.mode === 'value' && profile.worseThanTable.points === 0;

    if (!aRowScoresZero && !worseThanTableIsZero) {
      ctx.addIssue({
        code: 'custom',
        path: ['pickup', 'policy'],
        message:
          'pickup.policy is "cap_at_first_zero", but no score in this profile ever earns zero points: ' +
          'every table row scores above zero and worseThanTable does not drop to zero either. ' +
          'Add a zero-point row, set worseThanTable to a value of 0, or choose a different pickup policy.',
      });
    }
  }

  if (profile.basis === 'net' && profile.handicapAllocation === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['handicapAllocation'],
      message:
        'basis is "net", so handicapAllocation is required — the engine cannot allocate strokes without it.',
    });
  }

  if (profile.basis === 'gross' && profile.handicapAllocation !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['handicapAllocation'],
      message: 'handicapAllocation only applies when basis is "net".',
    });
  }
});

export type PointsTableRow = z.infer<typeof pointsTableRowSchema>;
export type TableBoundary = z.infer<typeof tableBoundarySchema>;
export type SpecialRule = z.infer<typeof specialRuleSchema>;
export type Pickup = z.infer<typeof pickupSchema>;
export type ScoringProfile = z.infer<typeof scoringProfileSchema>;
