import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  courseCheckIds,
  courseDocumentSchema,
  validateCourseDocument,
  type CourseDocument,
} from '../src/index';

const SEED_PATH = fileURLToPath(new URL('../../../seed/caledonia.json', import.meta.url));

function loadCaledonia(): CourseDocument {
  return courseDocumentSchema.parse(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
}

/** A deep copy, so a test that corrupts a value cannot affect another test. */
function corrupt(mutate: (document: CourseDocument) => void): CourseDocument {
  const copy = structuredClone(loadCaledonia());
  mutate(copy);
  return copy;
}

describe('the real Caledonia card', () => {
  it('parses', () => {
    const document = loadCaledonia();
    expect(document.course.name).toBe('Caledonia Golf & Fish Club');
    expect(document.teeSets.map((teeSet) => teeSet.name)).toEqual([
      'Pintail',
      'Mallard',
      'Wood Duck',
      'Redhead',
    ]);
  });

  it('passes every check, with nothing failing and nothing to review', () => {
    const result = validateCourseDocument(loadCaledonia());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('runs all ten checks against each of the four tee sets', () => {
    const result = validateCourseDocument(loadCaledonia());
    // Nine checks per tee set, plus one that compares tee sets against each other.
    expect(courseCheckIds).toHaveLength(10);
    expect(result.checks).toHaveLength(9 * 4 + 1);

    const ids = [...new Set(result.checks.map((check) => check.id))].sort();
    expect(ids).toEqual([...courseCheckIds].sort());
  });

  it('reports 35 out, 35 in, 70 total', () => {
    const pintail = loadCaledonia().teeSets[0];
    const holes = pintail?.holes ?? [];
    const out = holes.filter((hole) => hole.holeNumber <= 9).reduce((sum, h) => sum + h.par, 0);
    const back = holes.filter((hole) => hole.holeNumber > 9).reduce((sum, h) => sum + h.par, 0);
    expect([out, back, out + back]).toEqual([35, 35, 70]);
    expect(pintail?.parTotal).toBe(70);
  });

  it('summarises in a sentence a planner can read', () => {
    const result = validateCourseDocument(loadCaledonia());
    expect(result.summary).toBe('Caledonia Golf & Fish Club: 37 passed.');
  });

  it('skips nothing, because the card carries every field', () => {
    // Par, stroke index and yardage for all 18 holes of all four tee sets, plus rating,
    // slope and printed totals. Nothing falls back to "not applicable".
    const statuses = validateCourseDocument(loadCaledonia()).checks.map((check) => check.status);
    expect([...new Set(statuses)]).toEqual(['pass']);
  });

  it('confirms the odd/even stroke index split the spec describes', () => {
    const pintail = loadCaledonia().teeSets[0];
    const holes = pintail?.holes ?? [];
    const frontIndexes = holes.filter((h) => h.holeNumber <= 9).map((h) => h.strokeIndex);
    const backIndexes = holes.filter((h) => h.holeNumber > 9).map((h) => h.strokeIndex);
    expect(frontIndexes.every((index) => (index ?? 0) % 2 === 0)).toBe(true);
    expect(backIndexes.every((index) => (index ?? 0) % 2 === 1)).toBe(true);
  });
});

describe('corrupting one par value', () => {
  it('is rejected, because the pars no longer sum to the printed total', () => {
    const document = corrupt((copy) => {
      const hole = copy.teeSets[0]?.holes[0];
      if (hole === undefined) throw new Error('no first hole');
      hole.par = 5; // hole 1 at Caledonia is a par 4
    });

    const result = validateCourseDocument(document);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.id)).toContain('par_totals');
    expect(result.errors[0]?.detail).toContain('add up to 71');
    expect(result.errors[0]?.detail).toContain('card prints 70');
  });

  it('names the tee set the mistake is in', () => {
    const document = corrupt((copy) => {
      const hole = copy.teeSets[2]?.holes[5];
      if (hole === undefined) throw new Error('no hole');
      // Hole 6 is a par 3 on every tee set, so it has to change to something else.
      expect(hole.par).toBe(3);
      hole.par = 5;
    });
    const result = validateCourseDocument(document);
    expect(result.errors[0]?.teeSet).toBe('Wood Duck');
  });

  it('is caught even when it cancels out in the total, by the range check', () => {
    // Two errors that sum to zero would slip past a totals-only check.
    const document = corrupt((copy) => {
      const holes = copy.teeSets[0]?.holes;
      if (holes?.[0] === undefined || holes[1] === undefined) throw new Error('no holes');
      holes[0].par = 7; // out of range as well as wrong
      holes[1].par = 3;
    });
    const result = validateCourseDocument(document);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.id)).toContain('par_range');
  });
});

describe('the other nine checks', () => {
  it('catches a hole count that disagrees with the course', () => {
    const document = corrupt((copy) => {
      copy.teeSets[0]?.holes.pop();
    });
    const result = validateCourseDocument(document);
    expect(result.errors.map((error) => error.id)).toContain('hole_count');
  });

  it('catches a duplicated hole number', () => {
    const document = corrupt((copy) => {
      const hole = copy.teeSets[0]?.holes[4];
      if (hole === undefined) throw new Error('no hole');
      hole.holeNumber = 4;
    });
    const result = validateCourseDocument(document);
    expect(result.errors.map((error) => error.id)).toContain('hole_numbering');
  });

  it('catches a duplicated stroke index', () => {
    const document = corrupt((copy) => {
      const holes = copy.teeSets[0]?.holes;
      if (holes?.[0] === undefined || holes[1] === undefined) throw new Error('no holes');
      holes[1].strokeIndex = holes[0].strokeIndex;
    });
    const result = validateCourseDocument(document);
    const failure = result.errors.find((error) => error.id === 'stroke_index_permutation');
    expect(failure).toBeDefined();
    expect(failure?.detail).toMatch(/used more than once/);
  });

  it('catches a partial set of stroke indexes', () => {
    const document = corrupt((copy) => {
      const hole = copy.teeSets[0]?.holes[3];
      if (hole === undefined) throw new Error('no hole');
      hole.strokeIndex = null;
    });
    const result = validateCourseDocument(document);
    const failure = result.errors.find((error) => error.id === 'stroke_index_permutation');
    expect(failure?.detail).toMatch(/Enter all of them or none/);
  });

  it('flags a broken odd/even split for review rather than rejecting it', () => {
    const document = corrupt((copy) => {
      const holes = copy.teeSets[0]?.holes;
      if (holes?.[0] === undefined || holes[9] === undefined) throw new Error('no holes');
      const first = holes[0].strokeIndex;
      holes[0].strokeIndex = holes[9].strokeIndex;
      holes[9].strokeIndex = first;
    });
    const result = validateCourseDocument(document);
    expect(result.warnings.map((warning) => warning.id)).toContain('stroke_index_convention');
    // A convention, not arithmetic — it must not block saving.
    expect(result.valid).toBe(true);
  });

  it('catches a misread yardage', () => {
    const document = corrupt((copy) => {
      const hole = copy.teeSets[0]?.holes[7];
      if (hole === undefined) throw new Error('no hole');
      hole.yardage = (hole.yardage ?? 0) + 40;
    });
    const result = validateCourseDocument(document);
    expect(result.errors.map((error) => error.id)).toContain('yardage_totals');
  });

  it('catches an impossible slope', () => {
    const document = corrupt((copy) => {
      const teeSet = copy.teeSets[0];
      if (teeSet === undefined) throw new Error('no tee set');
      teeSet.slopeRating = 200;
    });
    const result = validateCourseDocument(document);
    expect(result.errors.map((error) => error.id)).toContain('slope_range');
  });

  it('flags a course rating nowhere near par', () => {
    const document = corrupt((copy) => {
      const teeSet = copy.teeSets[0];
      if (teeSet === undefined) throw new Error('no tee set');
      teeSet.courseRating = 55;
    });
    const result = validateCourseDocument(document);
    expect(result.warnings.map((warning) => warning.id)).toContain('course_rating_range');
  });

  it('flags a forward tee that plays longer than the tee behind it', () => {
    const document = corrupt((copy) => {
      // Swap two holes' yardages between adjacent tee sets, as a misaligned row would.
      const back = copy.teeSets[0]?.holes[2];
      const forward = copy.teeSets[1]?.holes[2];
      if (back === undefined || forward === undefined) throw new Error('no holes');
      forward.yardage = (back.yardage ?? 0) + 30;
    });
    const result = validateCourseDocument(document);
    const flagged = result.warnings.find(
      (warning) => warning.id === 'yardage_monotonic_across_tees',
    );
    expect(flagged).toBeDefined();
    expect(flagged?.detail).toMatch(/read out of order/);
  });
});

describe('a par-only course stays playable', () => {
  it('validates with no stroke index, yardage, slope or rating at all', () => {
    // The parking-lot case from spec 2.4b: eighteen taps and start a round.
    const parOnly: CourseDocument = courseDocumentSchema.parse({
      course: { name: 'Muni Nine', totalHoles: 9, source: 'manual' },
      teeSets: [
        {
          name: 'Default',
          holes: [4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, index) => ({
            holeNumber: index + 1,
            par,
          })),
        },
      ],
    });

    const result = validateCourseDocument(parOnly);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('still catches a wrong par when a total is supplied', () => {
    const document = courseDocumentSchema.parse({
      course: { name: 'Muni Nine', totalHoles: 9 },
      teeSets: [
        {
          name: 'Default',
          parTotal: 36,
          holes: [4, 3, 5, 4, 4, 3, 4, 5, 5].map((par, index) => ({
            holeNumber: index + 1,
            par,
          })),
        },
      ],
    });
    const result = validateCourseDocument(document);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.id).toBe('par_totals');
  });
});
