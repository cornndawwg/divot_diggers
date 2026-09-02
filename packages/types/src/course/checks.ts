import type { CourseDocument, TeeSet } from './schema.ts';

/**
 * The scorecard checksum suite from spec 2.3a.
 *
 * A scorecard is a highly redundant document: the pars are printed per hole AND totalled, the
 * stroke indexes are a permutation, the yardages sum. That redundancy means extracted data can
 * be checked against itself, so most OCR errors are caught here rather than discovered on the
 * 4th tee.
 *
 * Ten checks. Nine run per tee set; the tenth compares tee sets against each other.
 *
 * `error` means do not save — the data contradicts itself. `warning` means show the planner and
 * let them decide: the check encodes a convention rather than an arithmetic fact, and real
 * courses break conventions. `skipped` means the data needed is absent, which is not a fault:
 * stroke index and yardage are optional by design so a par-only course stays playable.
 */
export type CheckStatus = 'pass' | 'warning' | 'error' | 'skipped';

export interface CheckResult {
  readonly id: string;
  /** What the check is looking for, in words a planner can act on. */
  readonly label: string;
  readonly status: CheckStatus;
  /** Which tee set it applied to, or null for a course-level check. */
  readonly teeSet: string | null;
  /** Present when the status is not `pass`. */
  readonly detail?: string;
}

export interface CourseValidation {
  /** False when any check is an error. Warnings do not block saving. */
  readonly valid: boolean;
  readonly checks: readonly CheckResult[];
  readonly errors: readonly CheckResult[];
  readonly warnings: readonly CheckResult[];
  readonly summary: string;
}

const CHECK_IDS = [
  'hole_count',
  'hole_numbering',
  'par_range',
  'par_totals',
  'stroke_index_permutation',
  'stroke_index_convention',
  'yardage_totals',
  'slope_range',
  'course_rating_range',
  'yardage_monotonic_across_tees',
] as const;

/** The ten check ids, in the order they are reported. */
export type CheckId = (typeof CHECK_IDS)[number];
export const courseCheckIds: readonly CheckId[] = CHECK_IDS;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function front<T extends { holeNumber: number }>(holes: readonly T[]): readonly T[] {
  return holes.filter((hole) => hole.holeNumber <= 9);
}

function back<T extends { holeNumber: number }>(holes: readonly T[]): readonly T[] {
  return holes.filter((hole) => hole.holeNumber > 9);
}

function checkTeeSet(teeSet: TeeSet, totalHoles: number): CheckResult[] {
  const name = teeSet.name;
  const holes = [...teeSet.holes].sort((a, b) => a.holeNumber - b.holeNumber);
  const results: CheckResult[] = [];

  const add = (id: CheckId, label: string, status: CheckStatus, detail?: string): void => {
    results.push(detail === undefined ? { id, label, status, teeSet: name } : { id, label, status, teeSet: name, detail });
  };

  // 1 — the card has as many holes as the course claims.
  add(
    'hole_count',
    'Hole count matches the course',
    holes.length === totalHoles ? 'pass' : 'error',
    holes.length === totalHoles
      ? undefined
      : `The course says ${totalHoles} holes but this tee set lists ${holes.length}.`,
  );

  // 2 — numbered 1..n exactly once each. Catches a duplicated or dropped row.
  const numbers = holes.map((hole) => hole.holeNumber);
  const expected = Array.from({ length: holes.length }, (_, index) => index + 1);
  const numberingOk = numbers.length === expected.length && numbers.every((value, index) => value === expected[index]);
  add(
    'hole_numbering',
    'Holes are numbered 1 upwards with none missing or repeated',
    numberingOk ? 'pass' : 'error',
    numberingOk ? undefined : `Hole numbers read ${numbers.join(', ')}.`,
  );

  // 3 — a par outside 3..6 is a gross extraction failure, not a strange golf hole.
  const badPars = holes.filter((hole) => hole.par < 3 || hole.par > 6);
  add(
    'par_range',
    'Every par is between 3 and 6',
    badPars.length === 0 ? 'pass' : 'error',
    badPars.length === 0
      ? undefined
      : badPars.map((hole) => `hole ${hole.holeNumber} reads par ${hole.par}`).join('; ') + '.',
  );

  // 4 — pars sum to the printed totals. The single most valuable check: any misread par
  //     breaks it.
  const parProblems: string[] = [];
  const parSum = sum(holes.map((hole) => hole.par));
  if (teeSet.parTotal != null && parSum !== teeSet.parTotal) {
    parProblems.push(`the holes add up to ${parSum} but the card prints ${teeSet.parTotal}`);
  }
  const parOutSum = sum(front(holes).map((hole) => hole.par));
  const parInSum = sum(back(holes).map((hole) => hole.par));
  if (teeSet.parOut != null && parOutSum !== teeSet.parOut) {
    parProblems.push(`the front nine adds up to ${parOutSum} but the card prints ${teeSet.parOut}`);
  }
  if (teeSet.parIn != null && parInSum !== teeSet.parIn) {
    parProblems.push(`the back nine adds up to ${parInSum} but the card prints ${teeSet.parIn}`);
  }
  const anyParTotal = teeSet.parTotal != null || teeSet.parOut != null || teeSet.parIn != null;
  add(
    'par_totals',
    'Pars sum to the totals printed on the card',
    !anyParTotal ? 'skipped' : parProblems.length === 0 ? 'pass' : 'error',
    !anyParTotal
      ? 'The card carries no printed par total to check against.'
      : parProblems.length === 0
        ? undefined
        : `${parProblems.join('; ')}.`,
  );

  // 5 — stroke indexes are a permutation of 1..n. Catches a duplicate or a dropped index.
  const indexes = holes
    .map((hole) => hole.strokeIndex)
    .filter((value): value is number => value != null);
  if (indexes.length === 0) {
    add('stroke_index_permutation', 'Stroke indexes are each used once', 'skipped', 'No stroke indexes entered; they are optional.');
    add('stroke_index_convention', 'Front nine stroke indexes even, back nine odd', 'skipped', 'No stroke indexes entered.');
  } else if (indexes.length !== holes.length) {
    add(
      'stroke_index_permutation',
      'Stroke indexes are each used once',
      'error',
      `${indexes.length} of ${holes.length} holes have a stroke index. Enter all of them or none.`,
    );
    add('stroke_index_convention', 'Front nine stroke indexes even, back nine odd', 'skipped', 'Stroke indexes are incomplete.');
  } else {
    const sorted = [...indexes].sort((a, b) => a - b);
    const permutationOk = sorted.every((value, position) => value === position + 1);
    const duplicates = [...new Set(indexes.filter((value, i) => indexes.indexOf(value) !== i))];
    add(
      'stroke_index_permutation',
      'Stroke indexes are each used once',
      permutationOk ? 'pass' : 'error',
      permutationOk
        ? undefined
        : duplicates.length > 0
          ? `Stroke index ${duplicates.join(', ')} is used more than once.`
          : `Stroke indexes should be 1 to ${holes.length}; they read ${sorted.join(', ')}.`,
    );

    // 6 — the usual convention is odd on one nine and even on the other. A row read one line
    //     out of alignment breaks it. Real courses do break it too, so this only warns.
    const frontIndexes = front(holes).map((hole) => hole.strokeIndex ?? 0);
    const backIndexes = back(holes).map((hole) => hole.strokeIndex ?? 0);
    const splitOk =
      holes.length !== 18 ||
      (frontIndexes.every((value) => value % 2 === 0) && backIndexes.every((value) => value % 2 === 1)) ||
      (frontIndexes.every((value) => value % 2 === 1) && backIndexes.every((value) => value % 2 === 0));
    add(
      'stroke_index_convention',
      'Front nine stroke indexes even, back nine odd',
      holes.length !== 18 ? 'skipped' : splitOk ? 'pass' : 'warning',
      holes.length !== 18
        ? 'The convention only applies to an 18 hole card.'
        : splitOk
          ? undefined
          : 'The odd/even split across the two nines is broken, which usually means a row was read out of alignment. Plenty of courses genuinely break it, so check the card.',
    );
  }

  // 7 — yardages sum to the printed totals.
  const yardages = holes
    .map((hole) => hole.yardage)
    .filter((value): value is number => value != null);
  const yardageProblems: string[] = [];
  if (yardages.length === 0) {
    add('yardage_totals', 'Yardages sum to the totals printed on the card', 'skipped', 'No yardages entered; they are optional.');
  } else if (yardages.length !== holes.length) {
    add(
      'yardage_totals',
      'Yardages sum to the totals printed on the card',
      'warning',
      `${yardages.length} of ${holes.length} holes have a yardage. Yardage is cosmetic, so this does not block saving.`,
    );
  } else {
    const yardageSum = sum(yardages);
    if (teeSet.yardageTotal != null && yardageSum !== teeSet.yardageTotal) {
      yardageProblems.push(`the holes add up to ${yardageSum} but the card prints ${teeSet.yardageTotal}`);
    }
    const outSum = sum(front(holes).map((hole) => hole.yardage ?? 0));
    const inSum = sum(back(holes).map((hole) => hole.yardage ?? 0));
    if (teeSet.yardageOut != null && outSum !== teeSet.yardageOut) {
      yardageProblems.push(`the front nine adds up to ${outSum} but the card prints ${teeSet.yardageOut}`);
    }
    if (teeSet.yardageIn != null && inSum !== teeSet.yardageIn) {
      yardageProblems.push(`the back nine adds up to ${inSum} but the card prints ${teeSet.yardageIn}`);
    }
    const anyYardageTotal =
      teeSet.yardageTotal != null || teeSet.yardageOut != null || teeSet.yardageIn != null;
    add(
      'yardage_totals',
      'Yardages sum to the totals printed on the card',
      !anyYardageTotal ? 'skipped' : yardageProblems.length === 0 ? 'pass' : 'error',
      !anyYardageTotal
        ? 'The card carries no printed yardage total to check against.'
        : yardageProblems.length === 0
          ? undefined
          : `${yardageProblems.join('; ')}.`,
    );
  }

  // 8 — slope outside 55..155 is not a slope.
  add(
    'slope_range',
    'Slope rating is between 55 and 155',
    teeSet.slopeRating == null
      ? 'skipped'
      : teeSet.slopeRating >= 55 && teeSet.slopeRating <= 155
        ? 'pass'
        : 'error',
    teeSet.slopeRating == null
      ? 'No slope rating entered; only net scoring needs it.'
      : teeSet.slopeRating >= 55 && teeSet.slopeRating <= 155
        ? undefined
        : `Slope reads ${teeSet.slopeRating}.`,
  );

  // 9 — a course rating is roughly par. Far from it means the wrong number was read.
  const ratingPlausible =
    teeSet.courseRating == null ||
    (teeSet.courseRating >= parSum - 12 && teeSet.courseRating <= parSum + 12);
  add(
    'course_rating_range',
    'Course rating is close to par',
    teeSet.courseRating == null ? 'skipped' : ratingPlausible ? 'pass' : 'warning',
    teeSet.courseRating == null
      ? 'No course rating entered; only net scoring needs it.'
      : ratingPlausible
        ? undefined
        : `Course rating reads ${teeSet.courseRating} against a par of ${parSum}, which is further apart than expected.`,
  );

  return results;
}

/** 10 — yardage should fall as the tees move forward, hole by hole. */
function checkYardageAcrossTees(document: CourseDocument): CheckResult {
  const id: CheckId = 'yardage_monotonic_across_tees';
  const label = 'Yardage falls from the back tees to the forward tees';

  const usable = document.teeSets.filter(
    (teeSet) =>
      teeSet.yardageTotal != null && teeSet.holes.every((hole) => hole.yardage != null),
  );
  if (usable.length < 2) {
    return {
      id,
      label,
      status: 'skipped',
      teeSet: null,
      detail: 'Fewer than two tee sets have a full set of yardages to compare.',
    };
  }

  const longestFirst = [...usable].sort(
    (a, b) => (b.yardageTotal ?? 0) - (a.yardageTotal ?? 0),
  );
  const breaks: string[] = [];
  for (let i = 1; i < longestFirst.length; i += 1) {
    const longer = longestFirst[i - 1];
    const shorter = longestFirst[i];
    if (longer === undefined || shorter === undefined) continue;
    for (const hole of longer.holes) {
      const other = shorter.holes.find((entry) => entry.holeNumber === hole.holeNumber);
      if (other === undefined) continue;
      if ((other.yardage ?? 0) > (hole.yardage ?? 0)) {
        breaks.push(
          `hole ${hole.holeNumber} is ${other.yardage} from ${shorter.name} but only ${hole.yardage} from ${longer.name}`,
        );
      }
    }
  }

  return breaks.length === 0
    ? { id, label, status: 'pass', teeSet: null }
    : {
        id,
        label,
        status: 'warning',
        teeSet: null,
        detail: `${breaks.slice(0, 4).join('; ')}${breaks.length > 4 ? `; and ${breaks.length - 4} more` : ''}. A forward tee playing longer usually means two rows were read out of order, though it does happen for real.`,
      };
}

/**
 * Run the full suite. Nothing here writes anything: it reports, and the caller decides.
 * Anything failing a check goes to the planner for review rather than saving silently.
 */
export function validateCourseDocument(document: CourseDocument): CourseValidation {
  const checks: CheckResult[] = [];
  for (const teeSet of document.teeSets) {
    checks.push(...checkTeeSet(teeSet, document.course.totalHoles));
  }
  checks.push(checkYardageAcrossTees(document));

  const errors = checks.filter((check) => check.status === 'error');
  const warnings = checks.filter((check) => check.status === 'warning');
  const passed = checks.filter((check) => check.status === 'pass');
  const skipped = checks.filter((check) => check.status === 'skipped');

  const parts = [`${passed.length} passed`];
  if (warnings.length > 0) parts.push(`${warnings.length} to review`);
  if (errors.length > 0) parts.push(`${errors.length} failed`);
  if (skipped.length > 0) parts.push(`${skipped.length} not applicable`);

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
    summary: `${document.course.name}: ${parts.join(', ')}.`,
  };
}
