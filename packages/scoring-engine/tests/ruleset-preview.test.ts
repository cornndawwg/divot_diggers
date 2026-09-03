import { describe, expect, it } from 'vitest';
import { parseRuleset, safeParseRuleset, type ScoringProfile } from '@ddga/types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyRound, holePoints, initialTargetState, pickupCapRelativeToPar } from '../src/index.ts';

/**
 * What the ruleset editor's preview does, without a browser.
 *
 * The console computes its preview by calling this engine on the draft the planner is
 * editing — not by re-implementing the scoring. So asserting the numbers here asserts what
 * the planner sees change on screen.
 */

const REFERENCE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

/** The same hypothetical nine the preview panel shows. */
const PARS = [4, 3, 5, 4, 4, 3, 4, 5, 4];
const STROKES = [4, 4, 5, 5, 4, 3, 6, 5, 4];

function previewOf(document: Record<string, unknown>, startingTarget = 36) {
  const ruleset = parseRuleset(document);
  const profile = ruleset.scoringProfiles[0] as ScoringProfile;
  const holes = PARS.map((par, index) => holePoints(STROKES[index] ?? par, par, profile));
  const total = holes.reduce((sum, points) => sum + points, 0);

  const competition = ruleset.competitions.find((entry) => entry.type === 'individual_target');
  if (competition?.type !== 'individual_target') throw new Error('no target competition');

  const outcome = applyRound(initialTargetState(startingTarget), total, competition.target, {
    holesInPlay: PARS.length,
  });

  return { holes, total, outcome, cap: pickupCapRelativeToPar(profile) };
}

/** Change one point value, the way the editor's number input does. */
function withBogeyWorth(points: number): Record<string, unknown> {
  const copy = structuredClone(REFERENCE) as {
    scoringProfiles: { table: { relativeToPar: number; points: number }[] }[];
  };
  const row = copy.scoringProfiles[0]?.table.find((entry) => entry.relativeToPar === 1);
  if (row === undefined) throw new Error('no bogey row');
  row.points = points;
  return copy as unknown as Record<string, unknown>;
}

describe('the preview on the hypothetical card', () => {
  it('scores each hole from the table', () => {
    const preview = previewOf(REFERENCE);
    // par, bogey, par, bogey, par, par, double, par, par
    expect(preview.holes).toEqual([3, 2, 3, 2, 3, 3, 1, 3, 3]);
    expect(preview.total).toBe(23);
  });

  it('shows the pickup cap derived from the table', () => {
    expect(previewOf(REFERENCE).cap).toBe(3);
  });

  it('halves the target for a nine, because this ruleset prorates', () => {
    const preview = previewOf(REFERENCE, 36);
    expect(preview.outcome.effectiveTarget).toBe(18);
    expect(preview.outcome.roundDelta).toBe(5);
    expect(preview.outcome.nextTarget).toBe(38.5);
  });
});

describe('editing the bogey value from 2 to 3', () => {
  // The verification step for task 2.7, as a test rather than a screenshot.
  const before = previewOf(REFERENCE);
  const after = previewOf(withBogeyWorth(3));

  it('changes the two bogey holes and nothing else', () => {
    expect(before.holes).toEqual([3, 2, 3, 2, 3, 3, 1, 3, 3]);
    expect(after.holes).toEqual([3, 3, 3, 3, 3, 3, 1, 3, 3]);
  });

  it('moves the points total from 23 to 25', () => {
    expect(before.total).toBe(23);
    expect(after.total).toBe(25);
  });

  it('moves the round result and the next target with it', () => {
    expect(before.outcome.roundDelta).toBe(5);
    expect(after.outcome.roundDelta).toBe(7);
    expect(before.outcome.nextTarget).toBe(38.5);
    expect(after.outcome.nextTarget).toBe(39.5);
  });

  it('leaves the pickup cap alone, since a bogey still scores something', () => {
    expect(after.cap).toBe(3);
  });

  it('moves the pickup cap when a bogey is made worth nothing', () => {
    // The cap is derived, so making bogey worthless pulls it in from par+3 to par+1.
    const worthless = previewOf(withBogeyWorth(0));
    expect(worthless.cap).toBe(1);
  });
});

describe('a draft that does not make sense yet', () => {
  it('is rejected with a message rather than scoring nonsense', () => {
    const broken = structuredClone(REFERENCE) as {
      scoringProfiles: { table: { relativeToPar: number }[] }[];
    };
    // Delete the bogey row, leaving a gap the engine must not paper over.
    const table = broken.scoringProfiles[0]?.table;
    if (table === undefined) throw new Error('no table');
    broken.scoringProfiles[0]!.table = table.filter((row) => row.relativeToPar !== 1);

    expect(() => previewOf(broken as unknown as Record<string, unknown>)).toThrow(
      /consecutively/,
    );
  });
});

describe('extending the points table to better scores', () => {
  /** What the editor's "+ better score" button produces. */
  function withBetterRow(points: number): Record<string, unknown> {
    const copy = structuredClone(REFERENCE) as {
      scoringProfiles: { table: { relativeToPar: number; label: string; points: number }[] }[];
    };
    const table = copy.scoringProfiles[0]?.table;
    if (table === undefined) throw new Error('no table');
    const best = [...table].sort((a, b) => a.relativeToPar - b.relativeToPar)[0];
    if (best === undefined) throw new Error('no rows');
    table.push({ relativeToPar: best.relativeToPar - 1, label: 'Condor', points });
    return copy as unknown as Record<string, unknown>;
  }

  it('accepts a row better than the previous best', () => {
    // The reference table stops at 3 under. A group wanting to pay a condor adds 4 under.
    const extended = parseRuleset(withBetterRow(25));
    const rows = extended.scoringProfiles[0]?.table ?? [];
    expect(Math.min(...rows.map((row) => row.relativeToPar))).toBe(-4);
  });

  it('scores that new row rather than clamping to the old best', () => {
    const profile = parseRuleset(withBetterRow(25)).scoringProfiles[0] as ScoringProfile;
    // A 1 on a par 5 is four under.
    expect(holePoints(1, 5, profile)).toBe(25);
    // And the row below it is untouched.
    expect(holePoints(2, 5, profile)).toBe(16);
  });

  it('still clamps anything beyond the new best', () => {
    const profile = parseRuleset(withBetterRow(25)).scoringProfiles[0] as ScoringProfile;
    // Five under is beyond the table; betterThanTable is clamp in this ruleset.
    expect(holePoints(1, 6, profile)).toBe(25);
  });

  it('rejects a row that would leave a gap', () => {
    const gapped = structuredClone(REFERENCE) as {
      scoringProfiles: { table: { relativeToPar: number; label: string; points: number }[] }[];
    };
    // Jump straight to 5 under, skipping 4 under.
    gapped.scoringProfiles[0]?.table.push({ relativeToPar: -5, label: 'Whatever', points: 30 });
    const result = safeParseRuleset(gapped);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toMatch(
        /consecutively/,
      );
    }
  });
});
