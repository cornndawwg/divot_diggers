import { describe, expect, it } from 'vitest';
import {
  applyRounds,
  carriedStartingTarget,
  manualStartingTarget,
  rosterBalance,
  seedFromHandicap,
  suggestLapsedPlayerPtp,
} from '../src/index.ts';
import { dogfightCompetition, loadDogfightFixture } from './fixtures.ts';
import { cupCompetition } from './fixtures.ts';

const competition = dogfightCompetition();
const target = competition.target;

const roster2026 = loadDogfightFixture(2026).cases;
const expectedPtp = new Map(
  roster2026.map((entry) => [entry.player, entry.input.startingPtp]),
);

/**
 * Every 2026 starting target, computed from where it actually came from.
 *
 * Twelve are carried from the 2025 rounds. Three are seeded from a handicap index the spec
 * records. The remaining nine have no derivable source in this repository — no index and no
 * prior appearance — so they are what the schema calls `manual`: the planner typed them.
 * That is a real state, not a gap in the engine, and the roster records it so the archive can
 * explain any number later.
 */

/** Handicap indexes from docs/rules-engine-spec.md 1.3a. */
const DOCUMENTED_INDEXES: Record<string, number> = {
  'Mike Sinkule': 6.4,
  'Lee Butler': 20.0,
  'Shay Shamburger': 38.0,
};

/** Carried values, recomputed from the 2025 rounds rather than copied. */
function carriedFrom2025(): Map<string, number> {
  const carried = new Map<string, number>();
  for (const entry of loadDogfightFixture(2025).cases) {
    const result = applyRounds(entry.input.startingPtp, entry.input.pointsPulled, target);
    carried.set(entry.player, result.carryoverRaw);
  }
  return carried;
}

describe('building the 2026 event roster', () => {
  const carried = carriedFrom2025();

  it('has 24 players this year, which is a fact about this year and not a rule', () => {
    expect(roster2026).toHaveLength(24);
  });

  it('carries twelve players forward, each matching the fixture', () => {
    const returners = roster2026.filter((entry) => carried.has(entry.player));
    expect(returners).toHaveLength(12);

    for (const entry of returners) {
      const raw = carried.get(entry.player);
      if (raw === undefined) throw new Error(`no carry value for ${entry.player}`);
      const seeded = carriedStartingTarget(raw, target);
      expect(seeded.source).toBe('carried');
      expect(seeded.value, entry.player).toBe(entry.input.startingPtp);
    }
  });

  it('seeds three players from the handicap indexes the spec records', () => {
    for (const [player, index] of Object.entries(DOCUMENTED_INDEXES)) {
      const seeded = seedFromHandicap(index, target);
      expect(seeded.source).toBe('seeded_from_handicap');
      expect(seeded.value, player).toBe(expectedPtp.get(player));
    }
    // 54 − 6.4 = 47.6, which rounds half up to 48.
    expect(seedFromHandicap(6.4, target).raw).toBe(47.6);
    expect(seedFromHandicap(6.4, target).value).toBe(48);
  });

  it('reproduces all 24 starting targets, and labels where each came from', () => {
    const seeded = roster2026.map((entry) => {
      const raw = carried.get(entry.player);
      if (raw !== undefined) return { player: entry.player, ...carriedStartingTarget(raw, target) };

      const index = DOCUMENTED_INDEXES[entry.player];
      if (index !== undefined) {
        return { player: entry.player, ...seedFromHandicap(index, target) };
      }

      return {
        player: entry.player,
        ...manualStartingTarget(entry.input.startingPtp, 'no index or prior appearance on file'),
      };
    });

    for (const entry of seeded) {
      expect(entry.value, entry.player).toBe(expectedPtp.get(entry.player));
    }

    const bySource = seeded.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.source] = (counts[entry.source] ?? 0) + 1;
      return counts;
    }, {});
    // 15 of the 24 are genuinely derived; the other 9 are planner-entered.
    expect(bySource).toEqual({ carried: 12, seeded_from_handicap: 3, manual: 9 });
  });

  it('explains each number in a sentence a planner can read', () => {
    expect(carriedStartingTarget(14.375, target).explanation).toBe(
      'Carried forward from their last event at 14.375, which rounds to 14.',
    );
    expect(seedFromHandicap(38, target).explanation).toBe(
      'First appearance, seeded from a handicap index of 38: 54 − 38 = 16, which rounds to 16.',
    );
  });

  it('suggests a value for a player returning after a gap', () => {
    // Jack Denton last played 2023 off a target of 16 and starts 2026 on 32. A handicap-delta
    // suggestion is the starting point; the planner confirms, which is why the fixture value
    // and the suggestion need not agree.
    const suggestion = suggestLapsedPlayerPtp(
      {
        lastPtp: 16,
        handicapIndexAtLastAppearance: 38,
        currentHandicapIndex: 22,
        eventsMissed: 1,
      },
      target,
    );
    expect(suggestion.suggestedPtp).toBe(32);
    expect(suggestion.requiresPlannerConfirmation).toBe(true);
  });
});

describe('a roster that changes size every year', () => {
  const cup = cupCompetition();

  it('derives this year’s cup shape from 24 players, matching the ruleset exactly', () => {
    const balance = rosterBalance(24, cup);
    expect(balance.teamsEven).toBe(true);
    expect(balance.perTeam).toBe(12);
    expect(balance.sessions.map((session) => session.matchesThatFit)).toEqual([6, 6, 12]);
    expect(balance.pointsAvailable).toBe(24);
    expect(balance.clinchThreshold).toBe(13);
    expect(balance.issues).toEqual([]);
  });

  it('scales down to a twenty-player year', () => {
    const balance = rosterBalance(20, cup);
    expect(balance.perTeam).toBe(10);
    // Two sessions of pairs and one of singles.
    expect(balance.sessions.map((session) => session.matchesThatFit)).toEqual([5, 5, 10]);
    expect(balance.pointsAvailable).toBe(20);
    expect(balance.clinchThreshold).toBe(11);
    // And it says so, rather than letting the stale 24 stand.
    expect(balance.issues.join(' ')).toMatch(/contests 20 points, but the ruleset declares 24/);
  });

  it('scales up to a thirty-six-player year', () => {
    const balance = rosterBalance(36, cup);
    expect(balance.perTeam).toBe(18);
    expect(balance.sessions.map((session) => session.matchesThatFit)).toEqual([9, 9, 18]);
    expect(balance.pointsAvailable).toBe(36);
    expect(balance.clinchThreshold).toBe(19);
  });

  it('flags an odd roster, because the goal is even teams', () => {
    const balance = rosterBalance(23, cup);
    expect(balance.teamsEven).toBe(false);
    expect(balance.unplaced).toBe(1);
    expect(balance.issues[0]).toMatch(/cannot split into two even teams/);
  });

  it('says plainly when a roster is too small to play a format at all', () => {
    const balance = rosterBalance(2, cup);
    // One player a side: singles work, pairs cannot.
    expect(balance.sessions.map((session) => session.matchesThatFit)).toEqual([0, 0, 1]);
    expect(balance.issues.join(' ')).toMatch(/No match can be played/);
  });

  it('handles an empty roster without dividing by anything', () => {
    const balance = rosterBalance(0, cup);
    expect(balance.perTeam).toBe(0);
    expect(balance.pointsAvailable).toBe(0);
    expect(balance.teamsEven).toBe(true);
  });
});
