import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRuleset, type IndividualTargetCompetition, type ScoringProfile } from '@ddga/types';
import { applyRounds, holePoints, pickupCapRelativeToPar, standings } from '../src/index';

const ROOT = new URL('../../../', import.meta.url);

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, ROOT)), 'utf8'));
}

// ---------------------------------------------------------------------------
// A ruleset written from scratch, with nothing in common with the Divot Diggers
// ---------------------------------------------------------------------------

const ruleset = parseRuleset(readJson('presets/standard-stableford.json'));

const profile: ScoringProfile = (() => {
  const found = ruleset.scoringProfiles[0];
  if (found === undefined) throw new Error('preset has no scoring profile');
  return found;
})();

const competition: IndividualTargetCompetition = (() => {
  const found = ruleset.competitions[0];
  if (found === undefined || found.type !== 'individual_target') {
    throw new Error('preset has no individual_target competition');
  }
  return found;
})();

/** The starting target comes from the preset, not from the test. */
const startingTarget =
  competition.target.initialValue.method === 'fixed' ? competition.target.initialValue.value : 0;

// ---------------------------------------------------------------------------
// A real course, from the scanned Caledonia card
// ---------------------------------------------------------------------------

interface Hole {
  readonly holeNumber: number;
  readonly par: number;
  readonly strokeIndex: number;
}

const pintail: readonly Hole[] = (() => {
  const course = readJson('seed/caledonia.json') as {
    teeSets: { name: string; holes: Hole[] }[];
  };
  const tees = course.teeSets.find((teeSet) => teeSet.name === 'Pintail');
  if (tees === undefined) throw new Error('Caledonia has no Pintail tee set');
  return tees.holes;
})();

/**
 * Strokes a player receives on one hole. Standard stroke-index allocation, and the caller's
 * job rather than the engine's — the engine is handed a net par and scores against it.
 */
function strokesReceived(courseHandicap: number, strokeIndex: number, holeCount = 18): number {
  if (courseHandicap <= 0) return 0;
  const everyHole = Math.floor(courseHandicap / holeCount);
  const remainder = courseHandicap % holeCount;
  return everyHole + (strokeIndex <= remainder ? 1 : 0);
}

/**
 * Score a net round. Net play needs no special engine support: the player's net par for the
 * hole is par plus the strokes they receive, and gross strokes are scored against that.
 */
function scoreRound(grossScores: readonly number[], courseHandicap: number): number {
  return grossScores.reduce((total, gross, index) => {
    const hole = pintail[index];
    if (hole === undefined) throw new Error(`no hole at index ${index}`);
    const netPar = hole.par + strokesReceived(courseHandicap, hole.strokeIndex);
    return total + holePoints(gross, netPar, profile);
  }, 0);
}

// ---------------------------------------------------------------------------

describe('the Stableford preset', () => {
  it('validates against the same schema as the Divot Diggers ruleset', () => {
    expect(() => parseRuleset(readJson('presets/standard-stableford.json'))).not.toThrow();
  });

  it('is a system preset any org can clone', () => {
    expect(ruleset.orgId).toBeNull();
  });

  it('shares no scoring values with the Divot Diggers ruleset', () => {
    expect(profile.table.map((row) => row.points)).toEqual([5, 4, 3, 2, 1]);
    expect(competition.target.adjustmentFactor).toBe(0);
    expect(competition.target.carryover).toBe('none');
  });
});

describe('hole scoring on the Stableford table', () => {
  it('scores a par 4 the Stableford way', () => {
    expect(holePoints(6, 4, profile)).toBe(0); // double bogey or worse
    expect(holePoints(5, 4, profile)).toBe(1); // bogey
    expect(holePoints(4, 4, profile)).toBe(2); // par
    expect(holePoints(3, 4, profile)).toBe(3); // birdie
    expect(holePoints(2, 4, profile)).toBe(4); // eagle
    expect(holePoints(1, 4, profile)).toBe(5); // albatross
  });

  it('scores an ace on a par 3 as an eagle, with no special rule configured', () => {
    expect(holePoints(1, 3, profile)).toBe(4);
    expect(profile.specialRules).toHaveLength(0);
  });

  it('clamps anything better than the table', () => {
    expect(holePoints(1, 5, profile)).toBe(5);
  });

  it('derives a pickup cap of par+2 from this table', () => {
    // The Divot Diggers table caps at par+3. Same code, different config.
    expect(pickupCapRelativeToPar(profile)).toBe(2);
  });
});

describe('a full round on Caledonia', () => {
  const parEveryHole = pintail.map((hole) => hole.par);

  it('gives a scratch player who shoots par exactly 36 points', () => {
    expect(scoreRound(parEveryHole, 0)).toBe(36);
  });

  it('gives a 20 handicap playing to their handicap exactly 36 points', () => {
    const grossCard = pintail.map((hole) => hole.par + strokesReceived(20, hole.strokeIndex));
    expect(grossCard.reduce((sum, strokes) => sum + strokes, 0)).toBe(90);
    expect(scoreRound(grossCard, 20)).toBe(36);
  });

  it('gives 18 points to a player one over net on every hole', () => {
    const grossCard = pintail.map(
      (hole) => hole.par + strokesReceived(20, hole.strokeIndex) + 1,
    );
    expect(scoreRound(grossCard, 20)).toBe(18);
  });

  it('scores a realistic card', () => {
    const grossCard = [5, 7, 4, 5, 7, 4, 5, 6, 4, 6, 4, 5, 5, 6, 6, 7, 4, 5];
    expect(grossCard.reduce((sum, strokes) => sum + strokes, 0)).toBe(95);
    expect(scoreRound(grossCard, 20)).toBe(31);
  });
});

describe('the target machinery, with the target switched off', () => {
  it('never moves the target', () => {
    const result = applyRounds(startingTarget, [36, 31], competition.target);
    expect(result.targetsByRound).toEqual([0, 0]);
    expect(result.carryoverRaw).toBe(0);
  });

  it('makes the running total the points total', () => {
    const result = applyRounds(startingTarget, [36, 31], competition.target);
    expect(result.runningTotalByRound).toEqual([36, 67]);
    expect(result.finalStanding).toBe(67);
  });

  it('does not carry anything into the next event', () => {
    expect(applyRounds(startingTarget, [36], competition.target).carriesAcrossEvents).toBe(false);
  });

  it('orders the field by points, highest first', () => {
    const field = [
      { player: 'Bogey golfer', finalStanding: 31 },
      { player: 'Played to handicap', finalStanding: 36 },
      { player: 'Good day', finalStanding: 41 },
    ];
    expect(standings(field, competition).map((entry) => entry.player)).toEqual([
      'Good day',
      'Played to handicap',
      'Bogey golfer',
    ]);
  });
});

describe('the engine knows nothing about either ruleset', () => {
  const engineSource = readdirSync(fileURLToPath(new URL('packages/scoring-engine/src', ROOT)))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file,
      text: readFileSync(
        fileURLToPath(new URL(`packages/scoring-engine/src/${file}`, ROOT)),
        'utf8',
      ),
    }));

  it('has source files to check', () => {
    expect(engineSource.length).toBeGreaterThan(0);
  });

  it.each(['stableford', 'divot', 'dogfight', 'winona'])(
    'never mentions "%s"',
    (term) => {
      const offenders = engineSource
        .filter((source) => source.text.toLowerCase().includes(term))
        .map((source) => source.file);
      expect(offenders).toEqual([]);
    },
  );
});
