import { z } from 'zod';

/**
 * The course document: one course, its tee sets, and the holes of each.
 *
 * Par and stroke index vary BY TEE SET, not by course, so holes hang off the tee set rather
 * than the course. Caledonia has four tee sets sharing pars but not yardages.
 *
 * Only par is mandatory. A course at `par_only` completeness must be immediately playable —
 * stroke index and yardage can be backfilled later without invalidating any score already
 * entered. See spec 2.3.
 */
export const courseHoleSchema = z.strictObject({
  holeNumber: z.number().int().min(1).max(36),
  par: z.number().int().min(3).max(6),
  yardage: z.number().int().min(1).max(900).nullish(),
  strokeIndex: z.number().int().min(1).max(36).nullish(),
});

export const teeSetSchema = z.strictObject({
  name: z.string().min(1),
  gender: z.enum(['mens', 'womens', 'unisex']).default('mens'),
  courseRating: z.number().min(50).max(85).nullish(),
  slopeRating: z.number().int().min(55).max(155).nullish(),
  /** The par total printed on the card. Checked against the holes, never trusted. */
  parTotal: z.number().int().min(27).max(80).nullish(),
  /** The yardage total printed on the card. Checked against the holes, never trusted. */
  yardageTotal: z.number().int().min(500).max(9000).nullish(),
  /** Printed nine-hole subtotals, when the card shows them. Photo import reads these. */
  parOut: z.number().int().nullish(),
  parIn: z.number().int().nullish(),
  yardageOut: z.number().int().nullish(),
  yardageIn: z.number().int().nullish(),
  holes: z.array(courseHoleSchema).min(1),
});

export const courseSchema = z.strictObject({
  name: z.string().min(1),
  address: z.string().nullish(),
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  totalHoles: z.number().int().min(1).max(36).default(18),
  verified: z.boolean().default(false),
  source: z.enum(['manual', 'scorecard_import', 'library', 'gps_match']).nullish(),
  /**
   * Licensed course data may never enter the shared library — the obligation outlives the
   * contract. The database enforces it with a trigger; this is the same rule at the edge.
   */
  provenance: z.enum(['owned', 'licensed']).default('owned'),
  licenseProvider: z.string().nullish(),
});

export const courseDocumentSchema = z.strictObject({
  course: courseSchema,
  teeSets: z.array(teeSetSchema).min(1, 'A course needs at least one tee set.'),
});

export type CourseHole = z.infer<typeof courseHoleSchema>;
export type TeeSet = z.infer<typeof teeSetSchema>;
export type Course = z.infer<typeof courseSchema>;
export type CourseDocument = z.infer<typeof courseDocumentSchema>;
