import { describe, expect, it } from 'vitest';
import { applyRounds, standings } from '../src/index';
import { dogfightCompetition, loadDogfightFixture, loadManifest } from './fixtures';

const manifest = loadManifest();
const competition = dogfightCompetition();
const target = competition.target;

describe('the golden years', () => {
  it('covers every year the manifest calls golden', () => {
    expect(manifest.goldenYears).toEqual([2019, 2021, 2023, 2025, 2026]);
  });

  it('adds up to 87 player-year cases', () => {
    const total = manifest.goldenYears
      .map((year) => loadDogfightFixture(year).cases.length)
      .reduce((sum, count) => sum + count, 0);
    expect(total).toBe(87);
  });
});

describe.each(manifest.goldenYears)('dogfight %i', (year) => {
  const fixture = loadDogfightFixture(year);

  describe.each(fixture.cases.map((testCase) => [testCase.player, testCase] as const))(
    '%s',
    (_player, testCase) => {
      const result = applyRounds(
        testCase.input.startingPtp,
        testCase.input.pointsPulled,
        target,
      );

      it('plays each round against the right target', () => {
        expect(result.targetsByRound).toEqual(testCase.expected.targetsByRound);
      });

      it('tracks the running total', () => {
        expect(result.runningTotalByRound).toEqual(testCase.expected.cumulativeDeltaByRound);
      });

      it('finishes on the expected standing', () => {
        expect(result.finalStanding).toBe(testCase.expected.finalStanding);
      });

      it('carries over at full precision', () => {
        expect(result.carryoverRaw).toBe(testCase.expected.carryoverRaw);
      });

      it('rounds the carry-over value half up', () => {
        expect(result.carryoverRounded).toBe(testCase.expected.carryoverRounded);
      });
    },
  );

  it('orders the field exactly as the fixture does', () => {
    const computed = standings(
      fixture.cases.map((testCase) => ({
        player: testCase.player,
        finalStanding: applyRounds(
          testCase.input.startingPtp,
          testCase.input.pointsPulled,
          target,
        ).finalStanding,
      })),
      competition,
    );

    const byPlayer = new Map(computed.map((entry) => [entry.player, entry.position]));
    for (const testCase of fixture.cases) {
      expect(byPlayer.get(testCase.player)).toBe(testCase.expected.position);
    }
  });
});
