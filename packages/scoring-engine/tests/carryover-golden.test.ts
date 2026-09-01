import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyRounding } from '../src/index';
import { dogfightCompetition } from './fixtures';

interface CarryoverCase {
  readonly player: string;
  readonly fromYear: number;
  readonly toYear: number;
  readonly rawCarryValue: number;
  readonly expectedStartingPtp: number;
  readonly observedStartingPtp: number;
  readonly agrees: boolean;
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/ptp-carryover.json', import.meta.url)),
    'utf8',
  ),
) as { readonly cases: readonly CarryoverCase[] };

const target = dogfightCompetition().target;

/**
 * The six 2021 -> 2022 transitions the planner adjusted by hand. Named here so they are
 * accounted for rather than quietly skipped: each one is a case where the engine is right and
 * a human overruled it, which is the evidence that planner override is a required feature.
 */
interface PlannerAdjustment {
  readonly player: string;
  readonly computed: number;
  readonly plannerSet: number;
}

const PLANNER_ADJUSTED_2021_TO_2022: readonly PlannerAdjustment[] = [
  { player: 'Michael Chapman', computed: 5, plannerSet: 6 },
  { player: 'Jack Denton', computed: 17, plannerSet: 18 },
  { player: 'Levi Livermont', computed: 24, plannerSet: 26 },
  { player: 'Elliot Griffiths', computed: 33, plannerSet: 37 },
  { player: 'Kenny Adkins', computed: 12, plannerSet: 13 },
  { player: 'Justin Crumpler', computed: 29, plannerSet: 28 },
];

/** What the engine says this year's carry-over becomes as next year's starting target. */
function engineCarryover(rawCarryValue: number): number {
  return applyRounding(rawCarryValue, target.carryoverRounding);
}

describe('the carry-over chain', () => {
  it('holds 41 transitions', () => {
    expect(fixture.cases).toHaveLength(41);
  });

  it('computes the documented carry value for every one of them', () => {
    // expectedStartingPtp is the mechanical answer; the engine must match all 41.
    for (const testCase of fixture.cases) {
      expect(
        engineCarryover(testCase.rawCarryValue),
        `${testCase.player} ${testCase.fromYear}->${testCase.toYear}`,
      ).toBe(testCase.expectedStartingPtp);
    }
  });

  it('reproduces 35 of the 41 starting targets the spreadsheet actually shows', () => {
    const reproduced = fixture.cases.filter(
      (testCase) => engineCarryover(testCase.rawCarryValue) === testCase.observedStartingPtp,
    );
    expect(reproduced).toHaveLength(35);
  });

  it('reproduces every transition except 2021 to 2022 in full', () => {
    const byTransition = new Map<string, { total: number; reproduced: number }>();
    for (const testCase of fixture.cases) {
      const key = `${testCase.fromYear}->${testCase.toYear}`;
      const tally = byTransition.get(key) ?? { total: 0, reproduced: 0 };
      tally.total += 1;
      if (engineCarryover(testCase.rawCarryValue) === testCase.observedStartingPtp) {
        tally.reproduced += 1;
      }
      byTransition.set(key, tally);
    }

    expect(Object.fromEntries(byTransition)).toEqual({
      '2019->2021': { total: 6, reproduced: 6 },
      '2021->2022': { total: 8, reproduced: 2 },
      '2023->2024': { total: 15, reproduced: 15 },
      '2025->2026': { total: 12, reproduced: 12 },
    });
  });
});

describe('the six planner adjustments', () => {
  const divergent = fixture.cases.filter(
    (testCase) => engineCarryover(testCase.rawCarryValue) !== testCase.observedStartingPtp,
  );

  it('are the only six divergences, and all of them are 2021 to 2022', () => {
    expect(divergent).toHaveLength(6);
    for (const testCase of divergent) {
      expect(testCase.fromYear).toBe(2021);
      expect(testCase.toYear).toBe(2022);
    }
  });

  it('are exactly the players named above, with the numbers named above', () => {
    const actual = divergent
      .map((testCase) => ({
        player: testCase.player,
        computed: engineCarryover(testCase.rawCarryValue),
        plannerSet: testCase.observedStartingPtp,
      }))
      .sort((a, b) => a.player.localeCompare(b.player));

    const expected = [...PLANNER_ADJUSTED_2021_TO_2022].sort((a, b) =>
      a.player.localeCompare(b.player),
    );

    expect(actual).toEqual(expected);
  });

  it('are overrides of a correct computation, not engine errors', () => {
    // In every case the engine agrees with the fixture's own expectedStartingPtp. The
    // divergence is against observedStartingPtp — what the planner typed instead.
    for (const testCase of divergent) {
      expect(engineCarryover(testCase.rawCarryValue)).toBe(testCase.expectedStartingPtp);
      expect(testCase.agrees).toBe(false);
    }
  });

  it('are mostly small upward nudges, but not uniformly so', () => {
    const adjustments = PLANNER_ADJUSTED_2021_TO_2022.map(
      (entry) => entry.plannerSet - entry.computed,
    );
    expect(adjustments.filter((value) => value > 0)).toHaveLength(5);
    // Justin Crumpler was moved down, and Elliot Griffiths by 4 rather than 1 or 2.
    expect(adjustments).toContain(-1);
    expect(Math.max(...adjustments)).toBe(4);
  });
});
