import { ScoringInputError } from './errors.ts';

/**
 * How to spread players across groups by their target.
 *
 * `balanced`  — each group gets a mix of strong and weak, so no group is stacked. Snake order
 *               across groups, which is the usual way of doing this by hand.
 * `similar`   — players of like ability together, so each group plays at its own pace.
 * `snake`     — strict serpentine by rank, the draft ordering.
 * `random`    — a straight draw. An individual competition does not care who you play with,
 *               and some groups would rather it were luck than arithmetic.
 * `manual`    — the planner arranges them; nothing is suggested.
 */
export type GroupingStrategy = 'balanced' | 'similar' | 'snake' | 'random' | 'manual';

export interface GroupablePlayer<TPlayer> {
  readonly player: TPlayer;
  /** Higher is better. The target a player is chasing. */
  readonly target: number;
}

export interface SuggestedGroup<TPlayer> {
  readonly sequence: number;
  readonly players: readonly TPlayer[];
}

export interface GroupingOptions {
  readonly strategy: GroupingStrategy;
  /** Players per group. Four is usual; a short roster leaves the last group smaller. */
  readonly groupSize: number;
  /** Injectable for `random`, so a draw can be reproduced in a test. */
  readonly random?: () => number;
}

/**
 * Suggest groupings. Suggestions only — spec 4.3 is explicit that the planner drags to adjust
 * and confirms, and nothing here auto-commits.
 *
 * The last group takes the remainder rather than being padded: nineteen players in fours is
 * four groups of four and one of three, which is what actually happens on a first tee.
 */
export function suggestGroups<TPlayer>(
  entries: readonly GroupablePlayer<TPlayer>[],
  options: GroupingOptions,
): SuggestedGroup<TPlayer>[] {
  const { strategy, groupSize } = options;
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    throw new ScoringInputError(
      `A group needs at least one player, received ${String(groupSize)}.`,
    );
  }
  if (entries.length === 0) return [];

  const groupCount = Math.ceil(entries.length / groupSize);
  const groups: TPlayer[][] = Array.from({ length: groupCount }, () => []);

  if (strategy === 'manual') {
    // Fill in the order given, changing nothing.
    entries.forEach((entry, index) => {
      groups[Math.floor(index / groupSize)]?.push(entry.player);
    });
    return groups.map((players, index) => ({ sequence: index + 1, players }));
  }

  if (strategy === 'random') {
    // A straight draw: shuffle, then deal in order.
    const draw = [...entries];
    const roll = options.random ?? Math.random;
    for (let i = draw.length - 1; i > 0; i -= 1) {
      const j = Math.floor(roll() * (i + 1));
      const a = draw[i];
      const b = draw[j];
      if (a !== undefined && b !== undefined) {
        draw[i] = b;
        draw[j] = a;
      }
    }
    draw.forEach((entry, index) => {
      groups[Math.floor(index / groupSize)]?.push(entry.player);
    });
    return groups.map((players, index) => ({ sequence: index + 1, players }));
  }

  // Strongest first. A stable sort, so equal targets keep the order they arrived in.
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.target - a.entry.target || a.index - b.index)
    .map((row) => row.entry);

  if (strategy === 'similar') {
    ranked.forEach((entry, index) => {
      groups[Math.floor(index / groupSize)]?.push(entry.player);
    });
  } else {
    // balanced and snake both serpentine; they differ only in what the caller means by it.
    ranked.forEach((entry, index) => {
      const round = Math.floor(index / groupCount);
      const position = index % groupCount;
      const target = round % 2 === 0 ? position : groupCount - 1 - position;
      groups[target]?.push(entry.player);
    });
  }

  return groups.map((players, index) => ({ sequence: index + 1, players }));
}

/** Tee times spaced evenly from a first time, for filling a sheet quickly. */
export function suggestTeeTimes(
  firstTime: string,
  groupCount: number,
  intervalMinutes: number,
): string[] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(firstTime.trim());
  if (match === null) {
    throw new ScoringInputError(`A tee time looks like "08:10", received "${firstTime}".`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new ScoringInputError(`"${firstTime}" is not a time of day.`);
  }
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new ScoringInputError(
      `Tee times need a gap of at least a minute, received ${String(intervalMinutes)}.`,
    );
  }

  const start = hours * 60 + minutes;
  return Array.from({ length: Math.max(0, groupCount) }, (_, index) => {
    const total = (start + index * intervalMinutes) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  });
}


export interface TwoSides<TPlayer> {
  readonly a: readonly TPlayer[];
  readonly b: readonly TPlayer[];
  readonly totalA: number;
  readonly totalB: number;
  /** How far apart the two sides are on combined target. Lower is a fairer match. */
  readonly gap: number;
}

/**
 * Split a field into two even sides of comparable strength.
 *
 * A serpentine is the right shape for tee groups but a poor one for two teams: across twelve
 * players it leaves the sides eleven points apart, which is a lopsided cup. This deals the
 * strongest player to whichever side is currently behind, then looks for single swaps that
 * bring the two totals closer — the same thing two captains do by eye, and it settles within
 * a point or two.
 *
 * Sides stay equal in size, or differ by one when the roster is odd, because a cup is played
 * head to head.
 */
export function splitIntoSides<TPlayer>(
  entries: readonly GroupablePlayer<TPlayer>[],
): TwoSides<TPlayer> {
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.target - a.entry.target || a.index - b.index)
    .map((row) => row.entry);

  const capacity = Math.ceil(ranked.length / 2);
  const sides: GroupablePlayer<TPlayer>[][] = [[], []];
  const totals = [0, 0];

  for (const entry of ranked) {
    // Whichever side is behind, unless it is already full.
    const behind = (totals[0] ?? 0) <= (totals[1] ?? 0) ? 0 : 1;
    const target = (sides[behind]?.length ?? 0) < capacity ? behind : 1 - behind;
    sides[target]?.push(entry);
    totals[target] = (totals[target] ?? 0) + entry.target;
  }

  // One pass of swaps. Each swap of x out of A for y out of B moves the difference by
  // 2(y - x), so the best swap is the one closest to halving it.
  let improved = true;
  while (improved) {
    improved = false;
    const difference = (totals[0] ?? 0) - (totals[1] ?? 0);
    if (difference === 0) break;

    const left = sides[0] ?? [];
    const right = sides[1] ?? [];
    let bestA = -1;
    let bestB = -1;
    let bestGap = Math.abs(difference);

    left.forEach((x, ai) => {
      right.forEach((y, bi) => {
        const gap = Math.abs(difference - 2 * (x.target - y.target));
        if (gap < bestGap) {
          bestGap = gap;
          bestA = ai;
          bestB = bi;
        }
      });
    });

    const x = bestA === -1 ? undefined : left[bestA];
    const y = bestB === -1 ? undefined : right[bestB];
    if (x !== undefined && y !== undefined) {
      left[bestA] = y;
      right[bestB] = x;
      totals[0] = (totals[0] ?? 0) - x.target + y.target;
      totals[1] = (totals[1] ?? 0) - y.target + x.target;
      improved = true;
    }
  }

  return {
    a: (sides[0] ?? []).map((entry) => entry.player),
    b: (sides[1] ?? []).map((entry) => entry.player),
    totalA: totals[0] ?? 0,
    totalB: totals[1] ?? 0,
    gap: Math.abs((totals[0] ?? 0) - (totals[1] ?? 0)),
  };
}


// ---------------------------------------------------------------------------
// Match play pairings
// ---------------------------------------------------------------------------

export type PairingStrategy = 'by_rank' | 'random';

export interface Match<TPlayer> {
  readonly sequence: number;
  readonly a: readonly TPlayer[];
  readonly b: readonly TPlayer[];
}

export interface PairingOptions {
  /** One a side for singles, two for a pairs format. From the ruleset's session. */
  readonly playersPerSide: number;
  /**
   * `by_rank` puts the strongest of one side against the strongest of the other, which keeps
   * every match competitive. `random` draws them out of a hat.
   */
  readonly strategy?: PairingStrategy;
  readonly random?: () => number;
}

function shuffled<T>(items: readonly T[], roll: () => number): T[] {
  const draw = [...items];
  for (let i = draw.length - 1; i > 0; i -= 1) {
    const j = Math.floor(roll() * (i + 1));
    const a = draw[i];
    const b = draw[j];
    if (a !== undefined && b !== undefined) {
      draw[i] = b;
      draw[j] = a;
    }
  }
  return draw;
}

/**
 * Pair two sides into matches.
 *
 * A team competition is not a grouping problem. Who plays with whom is the competition: a
 * pairs session is two of one side against two of the other, and a group that mixes the
 * teams arbitrarily is not a match at all. So this draws from the two sides rather than from
 * one pool, and anybody left over when the sides are uneven sits out rather than being
 * quietly attached to the wrong team.
 */
export function pairSides<TPlayer>(
  sideA: readonly GroupablePlayer<TPlayer>[],
  sideB: readonly GroupablePlayer<TPlayer>[],
  options: PairingOptions,
): { matches: Match<TPlayer>[]; sittingOut: { a: TPlayer[]; b: TPlayer[] } } {
  const { playersPerSide, strategy = 'by_rank' } = options;
  if (!Number.isInteger(playersPerSide) || playersPerSide < 1) {
    throw new ScoringInputError(
      `A side needs at least one player per match, received ${String(playersPerSide)}.`,
    );
  }

  const order = (side: readonly GroupablePlayer<TPlayer>[]): GroupablePlayer<TPlayer>[] =>
    strategy === 'random'
      ? shuffled(side, options.random ?? Math.random)
      : [...side]
          .map((entry, index) => ({ entry, index }))
          .sort((x, y) => y.entry.target - x.entry.target || x.index - y.index)
          .map((row) => row.entry);

  const rankedA = order(sideA);
  const rankedB = order(sideB);
  const matchCount = Math.floor(Math.min(rankedA.length, rankedB.length) / playersPerSide);

  const matches: Match<TPlayer>[] = [];
  for (let index = 0; index < matchCount; index += 1) {
    const from = index * playersPerSide;
    matches.push({
      sequence: index + 1,
      a: rankedA.slice(from, from + playersPerSide).map((entry) => entry.player),
      b: rankedB.slice(from, from + playersPerSide).map((entry) => entry.player),
    });
  }

  const used = matchCount * playersPerSide;
  return {
    matches,
    sittingOut: {
      a: rankedA.slice(used).map((entry) => entry.player),
      b: rankedB.slice(used).map((entry) => entry.player),
    },
  };
}

/**
 * Bundle matches into tee groups.
 *
 * A pairs match is already a foursome and goes off as one. Singles are twosomes, and sending
 * twelve of them off ten minutes apart is two hours of tee times, so two matches share a
 * group — four players, two separate matches inside it, which is how singles day actually
 * runs.
 */
export function matchesToTeeGroups<TPlayer>(
  matches: readonly Match<TPlayer>[],
  playersPerSide: number,
): SuggestedGroup<TPlayer>[] {
  const perGroup = Math.max(1, Math.floor(4 / (playersPerSide * 2)));
  const groups: SuggestedGroup<TPlayer>[] = [];

  for (let index = 0; index < matches.length; index += perGroup) {
    const bundle = matches.slice(index, index + perGroup);
    groups.push({
      sequence: groups.length + 1,
      players: bundle.flatMap((match) => [...match.a, ...match.b]),
    });
  }
  return groups;
}
