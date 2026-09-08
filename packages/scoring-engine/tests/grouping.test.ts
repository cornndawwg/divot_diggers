import { describe, expect, it } from 'vitest';
import {
  matchesToTeeGroups,
  pairSides,
  ScoringInputError,
  splitIntoSides,
  suggestGroups,
  suggestTeeTimes,
  type GroupablePlayer,
} from '../src/index.ts';

/** Twelve players with distinct targets, strongest 48 down to weakest 15. */
const FIELD: GroupablePlayer<string>[] = [
  ['Mike', 48], ['Justin', 46], ['Casey', 40], ['Wayne', 41],
  ['Elliot', 38], ['Kyle', 37], ['Peter', 33], ['Shon', 29],
  ['Jason', 30], ['Levi', 16], ['Kenny', 14], ['Patrick', 15],
].map(([player, target]) => ({ player: player as string, target: target as number }));

function targetsOf(group: readonly string[]): number[] {
  return group.map((name) => FIELD.find((entry) => entry.player === name)?.target ?? 0);
}

describe('splitting a field into groups', () => {
  it('makes as many groups as the size demands', () => {
    const groups = suggestGroups(FIELD, { strategy: 'balanced', groupSize: 4 });
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.players.length)).toEqual([4, 4, 4]);
    expect(groups.map((group) => group.sequence)).toEqual([1, 2, 3]);
  });

  it('leaves the last group short rather than padding it', () => {
    // Nineteen in fours is four fours and a three, which is what happens on a first tee.
    const nineteen = Array.from({ length: 19 }, (_, index) => ({
      player: `P${index + 1}`,
      target: 40 - index,
    }));
    const groups = suggestGroups(nineteen, { strategy: 'similar', groupSize: 4 });
    expect(groups.map((group) => group.players.length)).toEqual([4, 4, 4, 4, 3]);
  });

  it('places every player exactly once, whatever the strategy', () => {
    for (const strategy of ['balanced', 'similar', 'snake', 'manual'] as const) {
      const placed = suggestGroups(FIELD, { strategy, groupSize: 4 }).flatMap(
        (group) => group.players,
      );
      expect(placed.length, strategy).toBe(FIELD.length);
      expect(new Set(placed).size, strategy).toBe(FIELD.length);
    }
  });

  it('handles an empty field and a single player', () => {
    expect(suggestGroups([], { strategy: 'balanced', groupSize: 4 })).toEqual([]);
    const one = suggestGroups([{ player: 'Solo', target: 30 }], {
      strategy: 'balanced',
      groupSize: 4,
    });
    expect(one).toEqual([{ sequence: 1, players: ['Solo'] }]);
  });

  it('refuses a group size below one', () => {
    expect(() => suggestGroups(FIELD, { strategy: 'balanced', groupSize: 0 })).toThrow(
      /at least one player/,
    );
  });
});

describe('balanced', () => {
  const groups = suggestGroups(FIELD, { strategy: 'balanced', groupSize: 4 });

  it('gives every group a comparable total, so none is stacked', () => {
    const totals = groups.map((group) =>
      targetsOf(group.players).reduce((sum, target) => sum + target, 0),
    );
    // Twelve players totalling 387: an even split would be 129 each.
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(6);
  });

  it('puts a strong and a weak player in each group', () => {
    for (const group of groups) {
      const targets = targetsOf(group.players);
      expect(Math.max(...targets)).toBeGreaterThan(35);
      expect(Math.min(...targets)).toBeLessThan(35);
    }
  });
});

describe('similar', () => {
  const groups = suggestGroups(FIELD, { strategy: 'similar', groupSize: 4 });

  it('keeps like with like, so the groups are far apart', () => {
    const totals = groups.map((group) =>
      targetsOf(group.players).reduce((sum, target) => sum + target, 0),
    );
    expect(Math.max(...totals) - Math.min(...totals)).toBeGreaterThan(40);
  });

  it('puts the strongest four in the first group', () => {
    expect(groups[0]?.players).toEqual(['Mike', 'Justin', 'Wayne', 'Casey']);
  });

  it('puts the weakest in the last', () => {
    expect(targetsOf(groups[2]?.players ?? []).every((target) => target < 31)).toBe(true);
  });
});

describe('snake', () => {
  it('serpentines by rank, so the second round of picks reverses', () => {
    const groups = suggestGroups(FIELD, { strategy: 'snake', groupSize: 4 });
    // Three groups: picks 1,2,3 go out; picks 4,5,6 come back.
    expect(groups[0]?.players[0]).toBe('Mike'); // 48, first pick
    expect(groups[2]?.players[0]).toBe('Wayne'); // 41, third pick
    expect(groups[2]?.players[1]).toBe('Casey'); // 40, fourth pick, turning back
  });
});

describe('manual', () => {
  it('changes nothing, taking the order it was given', () => {
    const groups = suggestGroups(FIELD, { strategy: 'manual', groupSize: 4 });
    expect(groups[0]?.players).toEqual(['Mike', 'Justin', 'Casey', 'Wayne']);
  });
});

describe('tee times', () => {
  it('spaces them evenly from the first', () => {
    expect(suggestTeeTimes('08:00', 6, 10)).toEqual([
      '08:00',
      '08:10',
      '08:20',
      '08:30',
      '08:40',
      '08:50',
    ]);
  });

  it('rolls over the hour', () => {
    expect(suggestTeeTimes('07:50', 3, 8)).toEqual(['07:50', '07:58', '08:06']);
  });

  it('handles a single group and none at all', () => {
    expect(suggestTeeTimes('09:00', 1, 10)).toEqual(['09:00']);
    expect(suggestTeeTimes('09:00', 0, 10)).toEqual([]);
  });

  it('refuses something that is not a time', () => {
    expect(() => suggestTeeTimes('half eight', 4, 10)).toThrow(/looks like/);
    expect(() => suggestTeeTimes('25:00', 4, 10)).toThrow(/not a time of day/);
    expect(() => suggestTeeTimes('08:00', 4, 0)).toThrow(/at least a minute/);
  });
});

describe('splitting a field into two sides', () => {
  it('makes the sides level, where a serpentine would not', () => {
    // The same twelve players a serpentine leaves eleven points apart.
    const split = splitIntoSides(FIELD);
    expect(split.a).toHaveLength(6);
    expect(split.b).toHaveLength(6);
    expect(split.gap).toBeLessThanOrEqual(2);
    expect(split.totalA + split.totalB).toBe(387);
  });

  it('places everyone exactly once', () => {
    const split = splitIntoSides(FIELD);
    const all = [...split.a, ...split.b];
    expect(all).toHaveLength(FIELD.length);
    expect(new Set(all).size).toBe(FIELD.length);
  });

  it('splits an odd roster as evenly as it can', () => {
    const five = [48, 46, 41, 40, 38].map((target, index) => ({ player: `P${index}`, target }));
    const split = splitIntoSides(five);
    expect(Math.abs(split.a.length - split.b.length)).toBe(1);
    expect([...split.a, ...split.b]).toHaveLength(5);
  });

  it('handles a field of two, and of none', () => {
    const pair = splitIntoSides([
      { player: 'A', target: 40 },
      { player: 'B', target: 20 },
    ]);
    expect(pair.a).toHaveLength(1);
    expect(pair.b).toHaveLength(1);
    expect(pair.gap).toBe(20);

    const empty = splitIntoSides([]);
    expect(empty.a).toEqual([]);
    expect(empty.b).toEqual([]);
    expect(empty.gap).toBe(0);
  });

  it('is level when every player is equal', () => {
    const same = Array.from({ length: 8 }, (_, index) => ({ player: `P${index}`, target: 30 }));
    const split = splitIntoSides(same);
    expect(split.gap).toBe(0);
    expect(split.totalA).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Match play pairings
// ---------------------------------------------------------------------------

describe('pairSides', () => {
  // Two sides of six, so a pairs session is three matches and singles is six.
  const sideA = [48, 41, 38, 33, 29, 15].map((target, index) => ({
    player: { name: `a${index}` },
    target,
  }));
  const sideB = [46, 40, 37, 30, 16, 14].map((target, index) => ({
    player: { name: `b${index}` },
    target,
  }));

  it('puts two of one side against two of the other, never a mixed group', () => {
    const { matches } = pairSides(sideA, sideB, { playersPerSide: 2 });

    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.a).toHaveLength(2);
      expect(match.b).toHaveLength(2);
      // Every name on the A side starts with 'a'. A group that mixed the teams would not be
      // a match at all, which is the whole difference from an individual round.
      expect(match.a.every((player) => player.name.startsWith('a'))).toBe(true);
      expect(match.b.every((player) => player.name.startsWith('b'))).toBe(true);
    }
  });

  it('by rank, sends the strongest pair out against the strongest pair', () => {
    const { matches } = pairSides(sideA, sideB, { playersPerSide: 2, strategy: 'by_rank' });

    expect(matches[0]?.a.map((p) => p.name)).toEqual(['a0', 'a1']); // 48 and 41
    expect(matches[0]?.b.map((p) => p.name)).toEqual(['b0', 'b1']); // 46 and 40
    expect(matches[2]?.a.map((p) => p.name)).toEqual(['a4', 'a5']); // 29 and 15
  });

  it('makes one match per player for singles', () => {
    const { matches, sittingOut } = pairSides(sideA, sideB, { playersPerSide: 1 });

    expect(matches).toHaveLength(6);
    expect(sittingOut.a).toEqual([]);
    expect(sittingOut.b).toEqual([]);
  });

  it('sits out the surplus rather than lending them to the other team', () => {
    // Seven against six. Somebody has to sit, and it must not be by joining side B.
    const seven = [...sideA, { player: { name: 'a6' }, target: 12 }];
    const { matches, sittingOut } = pairSides(seven, sideB, { playersPerSide: 1 });

    expect(matches).toHaveLength(6);
    expect(sittingOut.a.map((p) => p.name)).toEqual(['a6']); // the weakest, sat by rank
    expect(sittingOut.b).toEqual([]);
  });

  it('sits out a whole match short of a full pair', () => {
    // Five a side is two pairs matches with one player each side left over, not two and a half.
    const { matches, sittingOut } = pairSides(sideA.slice(0, 5), sideB.slice(0, 5), {
      playersPerSide: 2,
    });

    expect(matches).toHaveLength(2);
    expect(sittingOut.a).toHaveLength(1);
    expect(sittingOut.b).toHaveLength(1);
  });

  it('draws at random when asked, and the draw is reproducible', () => {
    const fixedRoll = (): number => 0.42;
    const first = pairSides(sideA, sideB, {
      playersPerSide: 2,
      strategy: 'random',
      random: fixedRoll,
    });
    const second = pairSides(sideA, sideB, {
      playersPerSide: 2,
      strategy: 'random',
      random: fixedRoll,
    });

    expect(first.matches).toEqual(second.matches);
    // Still team-legal: a random draw changes who plays whom, never which side they are on.
    for (const match of first.matches) {
      expect(match.a.every((player) => player.name.startsWith('a'))).toBe(true);
      expect(match.b.every((player) => player.name.startsWith('b'))).toBe(true);
    }
  });

  it('refuses a side size that is not a whole number of players', () => {
    expect(() => pairSides(sideA, sideB, { playersPerSide: 0 })).toThrow(ScoringInputError);
    expect(() => pairSides(sideA, sideB, { playersPerSide: 1.5 })).toThrow(ScoringInputError);
  });
});

describe('matchesToTeeGroups', () => {
  const sideA = [48, 41, 38, 33, 29, 15].map((t, i) => ({ player: { name: `a${i}` }, target: t }));
  const sideB = [46, 40, 37, 30, 16, 14].map((t, i) => ({ player: { name: `b${i}` }, target: t }));

  it('sends a pairs match off as its own foursome', () => {
    const { matches } = pairSides(sideA, sideB, { playersPerSide: 2 });
    const groups = matchesToTeeGroups(matches, 2);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.players.map((p) => p.name)).toEqual(['a0', 'a1', 'b0', 'b1']);
    expect(groups.every((group) => group.players.length === 4)).toBe(true);
  });

  it('puts two singles matches in one group, so singles day is not twelve tee times', () => {
    const { matches } = pairSides(sideA, sideB, { playersPerSide: 1 });
    const groups = matchesToTeeGroups(matches, 1);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.players.map((p) => p.name)).toEqual(['a0', 'b0', 'a1', 'b1']);
  });

  it('numbers the groups from one, in order', () => {
    const { matches } = pairSides(sideA, sideB, { playersPerSide: 2 });
    expect(matchesToTeeGroups(matches, 2).map((g) => g.sequence)).toEqual([1, 2, 3]);
  });
});

describe('a random draw for an individual round', () => {
  const field = Array.from({ length: 12 }, (_, index) => ({
    player: { name: `p${index}` },
    target: 40 - index,
  }));

  it('seats everybody exactly once', () => {
    const groups = suggestGroups(field, { strategy: 'random', groupSize: 4, random: () => 0.7 });
    const seated = groups.flatMap((group) => group.players.map((player) => player.name));

    expect(groups).toHaveLength(3);
    expect(new Set(seated).size).toBe(12);
  });

  it('is a draw, not the rank order dressed up', () => {
    const groups = suggestGroups(field, { strategy: 'random', groupSize: 4, random: () => 0.3 });
    const seated = groups.flatMap((group) => group.players.map((player) => player.name));

    expect(seated).not.toEqual(field.map((entry) => entry.player.name));
  });
});
