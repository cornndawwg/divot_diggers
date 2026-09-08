import { ScoringInputError } from './errors.ts';

/**
 * How to spread players across groups by their target.
 *
 * `balanced`  — each group gets a mix of strong and weak, so no group is stacked. Snake order
 *               across groups, which is the usual way of doing this by hand.
 * `similar`   — players of like ability together, so each group plays at its own pace.
 * `snake`     — strict serpentine by rank, the draft ordering.
 * `manual`    — the planner arranges them; nothing is suggested.
 */
export type GroupingStrategy = 'balanced' | 'similar' | 'snake' | 'manual';

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
