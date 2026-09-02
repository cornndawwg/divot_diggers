import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertScorecardMatchesRound,
  courseDocumentSchema,
  holeSelectionSchema,
  resolveHoles,
  HoleSelectionError,
  type CourseDocument,
} from '../src/index.ts';

const SEED_PATH = fileURLToPath(new URL('../../../seed/caledonia.json', import.meta.url));

function caledonia(): CourseDocument {
  return courseDocumentSchema.parse(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
}

function pintail() {
  const teeSet = caledonia().teeSets[0];
  if (teeSet === undefined) throw new Error('no Pintail tees');
  return teeSet;
}

describe('the verification case from BUILD-TASKS 2.5', () => {
  // An 18-hole dogfight round and a 9-hole Cup round, on the same course.
  const tees = pintail();

  it('gives the dogfight round 18 holes and par 70', () => {
    const round = resolveHoles(tees, { mode: 'all' });
    expect(round.holeCount).toBe(18);
    expect(round.parTotal).toBe(70);
    expect([round.outPar, round.inPar]).toEqual([35, 35]);
  });

  it('gives the Cup round 9 holes and par 35', () => {
    const round = resolveHoles(tees, { mode: 'front9' });
    expect(round.holeCount).toBe(9);
    expect(round.parTotal).toBe(35);
    // Scoring a nine against the card's 70 would put every player two dozen points adrift.
    expect(round.parTotal).not.toBe(tees.parTotal);
  });

  it('gives the back nine its own par, also 35 here', () => {
    const round = resolveHoles(tees, { mode: 'back9' });
    expect(round.holeCount).toBe(9);
    expect(round.parTotal).toBe(35);
    expect(round.holes.map((hole) => hole.holeNumber)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
});

describe('resolving a selection', () => {
  const tees = pintail();

  it('returns the holes in playing order', () => {
    const round = resolveHoles(tees, { mode: 'all' });
    expect(round.holes.map((hole) => hole.holeNumber)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
  });

  it('carries the real par, yardage and stroke index for each hole', () => {
    const round = resolveHoles(tees, { mode: 'front9' });
    const first = round.holes[0];
    // Hole 1 at Caledonia off the Pintail tees: par 4, 376 yards, stroke index 12.
    expect(first).toMatchObject({ holeNumber: 1, par: 4, yardage: 376, strokeIndex: 12 });
  });

  it('totals the yardage for the selection', () => {
    const all = resolveHoles(tees, { mode: 'all' });
    const out = resolveHoles(tees, { mode: 'front9' });
    const back = resolveHoles(tees, { mode: 'back9' });
    expect(all.yardageTotal).toBe(6526);
    expect((out.yardageTotal ?? 0) + (back.yardageTotal ?? 0)).toBe(6526);
  });

  it('reports holesInPlay, which is what prorateByHoles reads', () => {
    expect(resolveHoles(tees, { mode: 'all' }).holesInPlay).toBe(18);
    expect(resolveHoles(tees, { mode: 'front9' }).holesInPlay).toBe(9);
  });

  it('honours a custom selection in the order given', () => {
    // A replayed nine starting on the 10th, as a shotgun start might.
    const round = resolveHoles(tees, { mode: 'custom', holes: [10, 11, 12, 1, 2, 3] });
    expect(round.holes.map((hole) => hole.holeNumber)).toEqual([10, 11, 12, 1, 2, 3]);
    expect(round.holeCount).toBe(6);
    expect(round.parTotal).toBe(
      round.holes.reduce((sum, hole) => sum + hole.par, 0),
    );
    // Both nines are represented, so both subtotals are present.
    expect(round.outPar).not.toBeNull();
    expect(round.inPar).not.toBeNull();
  });

  it('resolves a named nine for a 27-hole facility', () => {
    const round = resolveHoles(
      tees,
      { mode: 'nine', nineId: 'lakes' },
      [{ id: 'lakes', name: 'Lakes', holeNumbers: [1, 2, 3, 10, 11, 12, 16, 17, 18] }],
    );
    expect(round.holes.map((hole) => hole.holeNumber)).toEqual([1, 2, 3, 10, 11, 12, 16, 17, 18]);
    expect(round.holeCount).toBe(9);
  });
});

describe('a selection that cannot be played', () => {
  const tees = pintail();

  it('refuses a hole the tee set does not have', () => {
    expect(() => resolveHoles(tees, { mode: 'custom', holes: [19] })).toThrow(
      /Hole 19 is not on the Pintail tees/,
    );
  });

  it('refuses the same hole listed twice', () => {
    expect(() => resolveHoles(tees, { mode: 'custom', holes: [1, 2, 1] })).toThrow(
      /listed twice/,
    );
  });

  it('refuses a back nine on a nine-hole course', () => {
    const nineHole = {
      name: 'Default',
      holes: [4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, index) => ({
        holeNumber: index + 1,
        par,
      })),
    };
    expect(() => resolveHoles(nineHole, { mode: 'back9' })).toThrow(HoleSelectionError);
    expect(() => resolveHoles(nineHole, { mode: 'back9' })).toThrow(/no back nine/);
  });

  it('treats front9 on a nine-hole course as the whole course', () => {
    const nineHole = {
      name: 'Default',
      holes: [4, 3, 5, 4, 4, 3, 4, 5, 4].map((par, index) => ({
        holeNumber: index + 1,
        par,
      })),
    };
    const round = resolveHoles(nineHole, { mode: 'front9' });
    expect(round.holeCount).toBe(9);
    expect(round.parTotal).toBe(36);
  });

  it('refuses an unknown named nine', () => {
    expect(() => resolveHoles(tees, { mode: 'nine', nineId: 'ghost' })).toThrow(
      /no nine with id "ghost"/,
    );
  });

  it('rejects a malformed selection at the schema', () => {
    expect(holeSelectionSchema.safeParse({ mode: 'front-nine' }).success).toBe(false);
    expect(holeSelectionSchema.safeParse({ mode: 'custom', holes: [] }).success).toBe(false);
    expect(holeSelectionSchema.safeParse({ mode: 'nine' }).success).toBe(false);
    expect(holeSelectionSchema.safeParse({ mode: 'all' }).success).toBe(true);
  });
});

describe('a submitted scorecard', () => {
  const tees = pintail();

  it('is accepted when it covers exactly the round', () => {
    const round = resolveHoles(tees, { mode: 'front9' });
    expect(() => assertScorecardMatchesRound(round, [1, 2, 3, 4, 5, 6, 7, 8, 9])).not.toThrow();
  });

  it('is rejected, not coerced, when it has too few holes', () => {
    const round = resolveHoles(tees, { mode: 'all' });
    expect(() => assertScorecardMatchesRound(round, [1, 2, 3])).toThrow(
      /plays 18 holes but the scorecard has 3/,
    );
  });

  it('is rejected when it has too many', () => {
    const round = resolveHoles(tees, { mode: 'front9' });
    expect(() =>
      assertScorecardMatchesRound(round, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    ).toThrow(/plays 9 holes but the scorecard has 10/);
  });

  it('is rejected when it covers the wrong holes', () => {
    const round = resolveHoles(tees, { mode: 'front9' });
    expect(() =>
      assertScorecardMatchesRound(round, [10, 11, 12, 13, 14, 15, 16, 17, 18]),
    ).toThrow(/missing hole 1, 2, 3/);
  });

  it('is rejected when a hole appears twice', () => {
    const round = resolveHoles(tees, { mode: 'custom', holes: [1, 2, 3] });
    expect(() => assertScorecardMatchesRound(round, [1, 2, 2])).toThrow(/same hole more than once/);
  });
});
