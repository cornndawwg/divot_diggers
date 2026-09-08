import { describe, expect, it } from 'vitest';
import { suggestGroups, suggestTeeTimes, type GroupablePlayer } from '../src/index.ts';

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
