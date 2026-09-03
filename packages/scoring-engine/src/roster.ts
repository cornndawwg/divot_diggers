import type { Target, TeamMatchPlayCompetition } from '@ddga/types';
import { ScoringConfigError, ScoringInputError } from './errors.ts';
import { applyRounding } from './rounding.ts';

/**
 * Where a player's starting target came from. The four sources the schema records, because a
 * planner needs to know later why a number is what it is — especially when they overrode it.
 */
export type StartingTargetSource =
  | 'carried'
  | 'seeded_from_handicap'
  | 'lapsed_adjusted'
  | 'manual';

export interface StartingTarget {
  readonly value: number;
  /** Before rounding. Equal to `value` for a source that produces a whole number. */
  readonly raw: number;
  readonly source: StartingTargetSource;
  /** A sentence the roster screen can show verbatim. */
  readonly explanation: string;
}

/**
 * Seed a first-timer from their handicap index.
 *
 * The constant, the handicap source and the rounding all come from config. One ruleset may
 * subtract the index from 54 and round half up; another may use a different constant, or
 * course handicap instead of index. Either changes the ruleset, never this function.
 */
export function seedFromHandicap(handicapIndex: number, config: Target): StartingTarget {
  if (!Number.isFinite(handicapIndex)) {
    throw new ScoringInputError(
      `A handicap index must be a finite number, received ${String(handicapIndex)}.`,
    );
  }

  const method = config.initialValue;
  if (method.method !== 'constant_minus_handicap') {
    throw new ScoringConfigError(
      `This ruleset seeds a first-timer by "${method.method}", not from a handicap index.`,
    );
  }

  const raw = method.constant - handicapIndex;
  const value = applyRounding(raw, method.rounding);
  return {
    value,
    raw,
    source: 'seeded_from_handicap',
    explanation: `First appearance, seeded from a handicap index of ${handicapIndex}: ${method.constant} − ${handicapIndex} = ${raw}, which rounds to ${value}.`,
  };
}

/** A target with no derivable source. The planner typed it, and the archive says so. */
export function manualStartingTarget(value: number, reason?: string): StartingTarget {
  if (!Number.isFinite(value)) {
    throw new ScoringInputError(`A starting target must be a finite number, received ${String(value)}.`);
  }
  return {
    value,
    raw: value,
    source: 'manual',
    explanation:
      reason === undefined || reason === ''
        ? `Set by hand to ${value}.`
        : `Set by hand to ${value}: ${reason}`,
  };
}

/** A target carried forward from the player's last event. */
export function carriedStartingTarget(raw: number, config: Target): StartingTarget {
  if (!Number.isFinite(raw)) {
    throw new ScoringInputError(`A carried target must be a finite number, received ${String(raw)}.`);
  }
  const value = applyRounding(raw, config.carryoverRounding);
  return {
    value,
    raw,
    source: 'carried',
    explanation:
      raw === value
        ? `Carried forward from their last event at ${value}.`
        : `Carried forward from their last event at ${raw}, which rounds to ${value}.`,
  };
}

// ---------------------------------------------------------------------------
// Roster size
// ---------------------------------------------------------------------------

export interface SessionCapacity {
  readonly roundId: string;
  readonly format: string;
  readonly playersPerSide: number;
  /** How many matches this roster actually supports. */
  readonly matchesThatFit: number;
  /** What the ruleset currently declares. */
  readonly declaredMatches: number;
  readonly matchesDeclaredFit: boolean;
}

export interface RosterBalance {
  readonly playerCount: number;
  /** The stated goal: teams even in number. */
  readonly teamsEven: boolean;
  readonly perTeam: number;
  /** How many players cannot be placed on an even team. 0 or 1. */
  readonly unplaced: number;
  readonly sessions: readonly SessionCapacity[];
  /** Points this roster can actually contest. */
  readonly pointsAvailable: number;
  /** The declared total, for comparison. */
  readonly declaredPointsAvailable: number;
  /** The smallest whole score that beats a tie. */
  readonly clinchThreshold: number;
  readonly declaredClinchThreshold: number;
  readonly matchesDeclaredConfig: boolean;
  /** Plain English, for the planner. Empty when the roster and the ruleset agree. */
  readonly issues: readonly string[];
}

/**
 * What a roster of this size can actually contest.
 *
 * Roster size is not stable: one year twenty attend, another thirty-six, and people join or
 * drop out between events. So the cup's shape is derived from the roster and compared against
 * what the ruleset declares, rather than the declared numbers being trusted. A planner who
 * adds four players finds out here that their session match counts no longer fit, instead of
 * finding out when four people have nothing to play.
 */
export function rosterBalance(
  playerCount: number,
  cup: TeamMatchPlayCompetition,
): RosterBalance {
  if (!Number.isInteger(playerCount) || playerCount < 0) {
    throw new ScoringInputError(
      `A roster size must be a whole number of players, received ${String(playerCount)}.`,
    );
  }

  const teamsEven = playerCount % 2 === 0;
  const perTeam = Math.floor(playerCount / 2);
  const issues: string[] = [];

  if (!teamsEven) {
    issues.push(
      `${playerCount} players cannot split into two even teams. One player is left over — add or drop one, or give someone a bye.`,
    );
  }

  const sessions = cup.sessions.map<SessionCapacity>((session) => {
    const matchesThatFit = Math.floor(perTeam / session.playersPerSide);
    return {
      roundId: session.roundId,
      format: session.format,
      playersPerSide: session.playersPerSide,
      matchesThatFit,
      declaredMatches: session.matches,
      matchesDeclaredFit: session.matches === matchesThatFit,
    };
  });

  for (const session of sessions) {
    if (session.matchesThatFit === 0) {
      issues.push(
        `${session.roundId} needs ${session.playersPerSide} players a side, but each team only has ${perTeam}. No match can be played.`,
      );
    } else if (!session.matchesDeclaredFit) {
      issues.push(
        `${session.roundId} declares ${session.declaredMatches} matches, but ${playerCount} players support ${session.matchesThatFit}.`,
      );
    }
  }

  const { win } = cup.pointsPerMatch;
  const pointsAvailable = sessions.reduce(
    (total, session) => total + session.matchesThatFit * win,
    0,
  );
  // The smallest whole score that beats a tie. Half of 24 is 12, so 13 clinches.
  const clinchThreshold = Math.floor(pointsAvailable / 2) + 1;

  if (pointsAvailable !== cup.totalPointsAvailable) {
    issues.push(
      `This roster contests ${pointsAvailable} points, but the ruleset declares ${cup.totalPointsAvailable}.`,
    );
  }
  if (clinchThreshold !== cup.clinchThreshold) {
    issues.push(
      `${pointsAvailable} points available means ${clinchThreshold} clinches, but the ruleset says ${cup.clinchThreshold}.`,
    );
  }

  return {
    playerCount,
    teamsEven,
    perTeam,
    unplaced: playerCount % 2,
    sessions,
    pointsAvailable,
    declaredPointsAvailable: cup.totalPointsAvailable,
    clinchThreshold,
    declaredClinchThreshold: cup.clinchThreshold,
    matchesDeclaredConfig: issues.length === 0,
    issues,
  };
}
