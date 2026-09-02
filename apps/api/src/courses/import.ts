import {
  courseDocumentSchema,
  validateCourseDocument,
  type CourseDocument,
  type CourseValidation,
} from '@ddga/types';
import type { PoolClient } from 'pg';

export interface ImportOutcome {
  readonly courseId: string;
  readonly teeSetIds: readonly string[];
  readonly holeCount: number;
  readonly validation: CourseValidation;
}

export class CourseImportRejected extends Error {
  readonly validation: CourseValidation;

  constructor(validation: CourseValidation) {
    super(
      `Course "${validation.checks[0]?.teeSet ?? 'import'}" failed validation: ` +
        validation.errors.map((error) => `${error.label} — ${error.detail ?? ''}`).join(' | '),
    );
    this.name = 'CourseImportRejected';
    this.validation = validation;
  }
}

/**
 * Parse, validate, then write — in that order, and never any other.
 *
 * Every path that gets course data into the database goes through here: manual entry, the
 * seed importer, and the scorecard photo pipeline in 2.4a. Wiring the checksum suite in at
 * one chokepoint is the whole point; a second path that skips it would put a wrong par into
 * scoring, which silently corrupts every point calculation on that hole.
 */
export async function importCourse(
  client: PoolClient,
  orgId: string,
  createdBy: string | null,
  input: unknown,
): Promise<ImportOutcome> {
  const document: CourseDocument = courseDocumentSchema.parse(input);
  const validation = validateCourseDocument(document);
  if (!validation.valid) {
    throw new CourseImportRejected(validation);
  }

  const hasEveryStrokeIndex = document.teeSets.every((teeSet) =>
    teeSet.holes.every((hole) => hole.strokeIndex != null),
  );
  const hasEveryYardage = document.teeSets.every((teeSet) =>
    teeSet.holes.every((hole) => hole.yardage != null),
  );
  const completeness = document.course.verified
    ? 'verified'
    : hasEveryStrokeIndex && hasEveryYardage
      ? 'full'
      : 'par_only';

  const course = await client.query<{ id: string }>(
    `INSERT INTO courses (org_id, name, address, city, region, country, latitude, longitude,
                          total_holes, verified, source, completeness, created_by,
                          provenance, license_provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      orgId,
      document.course.name,
      document.course.address ?? null,
      document.course.city ?? null,
      document.course.region ?? null,
      document.course.country ?? null,
      document.course.latitude ?? null,
      document.course.longitude ?? null,
      document.course.totalHoles,
      document.course.verified,
      document.course.source ?? null,
      completeness,
      createdBy,
      document.course.provenance,
      document.course.licenseProvider ?? null,
    ],
  );
  const courseId = course.rows[0]?.id;
  if (courseId === undefined) throw new Error('the course insert returned no id');

  const teeSetIds: string[] = [];
  let holeCount = 0;

  for (const teeSet of document.teeSets) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tee_sets (course_id, name, gender, course_rating, slope_rating,
                             par_total, yardage_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        courseId,
        teeSet.name,
        teeSet.gender,
        teeSet.courseRating ?? null,
        teeSet.slopeRating ?? null,
        teeSet.parTotal ?? null,
        teeSet.yardageTotal ?? null,
      ],
    );
    const teeSetId = inserted.rows[0]?.id;
    if (teeSetId === undefined) throw new Error('the tee set insert returned no id');
    teeSetIds.push(teeSetId);

    for (const hole of teeSet.holes) {
      await client.query(
        `INSERT INTO course_holes (tee_set_id, hole_number, par, yardage, stroke_index)
         VALUES ($1,$2,$3,$4,$5)`,
        [teeSetId, hole.holeNumber, hole.par, hole.yardage ?? null, hole.strokeIndex ?? null],
      );
      holeCount += 1;
    }
  }

  return { courseId, teeSetIds, holeCount, validation };
}
