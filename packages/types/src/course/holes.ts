import { z } from 'zod';
import type { CourseHole, TeeSet } from './schema.ts';

/**
 * Which holes a round actually plays.
 *
 * Stated explicitly per round rather than inferred, because the Divot Diggers trip needs both
 * on the same day: the morning dogfight rounds are full 18s and the afternoon Cup sessions are
 * nines. Same course family, different hole counts, different competitions — that is the MVP
 * case, not an edge case (spec 2.2).
 */
export const holeSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('front9') }),
  z.strictObject({ mode: z.literal('back9') }),
  /** A named nine, for 27- and 36-hole facilities. */
  z.strictObject({ mode: z.literal('nine'), nineId: z.string().min(1) }),
  z.strictObject({
    mode: z.literal('custom'),
    holes: z.array(z.number().int().min(1).max(36)).min(1),
  }),
]);

export type HoleSelection = z.infer<typeof holeSelectionSchema>;

export interface CourseNine {
  readonly id: string;
  readonly name: string;
  readonly holeNumbers: readonly number[];
}

export class HoleSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoleSelectionError';
  }
}

export interface ResolvedRound {
  /** The holes to play, in playing order. */
  readonly holes: readonly CourseHole[];
  readonly holeCount: number;
  readonly parTotal: number;
  /** Par for the holes of this round that fall on the front nine, or null if none do. */
  readonly outPar: number | null;
  readonly inPar: number | null;
  /** null unless every hole in the selection carries a yardage. */
  readonly yardageTotal: number | null;
  /** What `prorateByHoles` reads. */
  readonly holesInPlay: number;
}

function sumPar(holes: readonly CourseHole[]): number {
  return holes.reduce((total, hole) => total + hole.par, 0);
}

/**
 * Turn a hole selection into the ordered list of holes to play, with its own par total.
 *
 * The par total comes from the selection, not from the card: a 9-hole round on a par 70 course
 * is a par 35 round, and scoring it against 70 would put every player two dozen points adrift.
 */
export function resolveHoles(
  teeSet: Pick<TeeSet, 'name' | 'holes'>,
  selection: HoleSelection,
  nines: readonly CourseNine[] = [],
): ResolvedRound {
  const available = [...teeSet.holes].sort((a, b) => a.holeNumber - b.holeNumber);

  let holes: readonly CourseHole[];
  switch (selection.mode) {
    case 'all':
      holes = available;
      break;
    case 'front9':
      holes = available.filter((hole) => hole.holeNumber <= 9);
      break;
    case 'back9':
      holes = available.filter((hole) => hole.holeNumber > 9 && hole.holeNumber <= 18);
      break;
    case 'nine': {
      const nine = nines.find((entry) => entry.id === selection.nineId);
      if (nine === undefined) {
        throw new HoleSelectionError(
          `This course has no nine with id "${selection.nineId}".`,
        );
      }
      const byNumber = new Map(available.map((hole) => [hole.holeNumber, hole]));
      const picked: CourseHole[] = [];
      for (const number of nine.holeNumbers) {
        const hole = byNumber.get(number);
        if (hole === undefined) {
          throw new HoleSelectionError(
            `The nine "${nine.name}" lists hole ${number}, which the ${teeSet.name} tees do not have.`,
          );
        }
        picked.push(hole);
      }
      holes = picked;
      break;
    }
    case 'custom': {
      const seen = new Set<number>();
      const byNumber = new Map(available.map((hole) => [hole.holeNumber, hole]));
      const picked: CourseHole[] = [];
      for (const number of selection.holes) {
        if (seen.has(number)) {
          throw new HoleSelectionError(`Hole ${number} is listed twice in this selection.`);
        }
        seen.add(number);
        const hole = byNumber.get(number);
        if (hole === undefined) {
          throw new HoleSelectionError(
            `Hole ${number} is not on the ${teeSet.name} tees, so it cannot be played.`,
          );
        }
        // Custom order is honoured as given: a shotgun start or a replayed nine may not
        // run in ascending order.
        picked.push(hole);
      }
      holes = picked;
      break;
    }
  }

  if (holes.length === 0) {
    throw new HoleSelectionError(
      selection.mode === 'back9'
        ? `The ${teeSet.name} tees have no back nine, so a back-nine round cannot be played on them.`
        : `That selection resolves to no holes on the ${teeSet.name} tees.`,
    );
  }

  const outHoles = holes.filter((hole) => hole.holeNumber <= 9);
  const inHoles = holes.filter((hole) => hole.holeNumber > 9);
  const everyYardage = holes.every((hole) => hole.yardage != null);

  return {
    holes,
    holeCount: holes.length,
    parTotal: sumPar(holes),
    outPar: outHoles.length > 0 ? sumPar(outHoles) : null,
    inPar: inHoles.length > 0 ? sumPar(inHoles) : null,
    yardageTotal: everyYardage
      ? holes.reduce((total, hole) => total + (hole.yardage ?? 0), 0)
      : null,
    holesInPlay: holes.length,
  };
}

/**
 * A submitted scorecard must cover exactly the holes the round plays.
 *
 * Rejected, never coerced (spec 2.2). Silently dropping an extra hole or filling a missing one
 * would change a score, and a score nobody entered is worse than an error message.
 */
export function assertScorecardMatchesRound(
  round: ResolvedRound,
  submittedHoleNumbers: readonly number[],
): void {
  const expected = round.holes.map((hole) => hole.holeNumber);
  const expectedSet = new Set(expected);
  const submittedSet = new Set(submittedHoleNumbers);

  if (submittedHoleNumbers.length !== submittedSet.size) {
    throw new HoleSelectionError('The scorecard lists the same hole more than once.');
  }
  if (submittedHoleNumbers.length !== expected.length) {
    throw new HoleSelectionError(
      `This round plays ${expected.length} holes but the scorecard has ${submittedHoleNumbers.length}.`,
    );
  }

  const missing = expected.filter((number) => !submittedSet.has(number));
  const extra = submittedHoleNumbers.filter((number) => !expectedSet.has(number));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing hole ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`hole ${extra.join(', ')} is not in this round`);
    throw new HoleSelectionError(`The scorecard does not match the round: ${parts.join('; ')}.`);
  }
}
