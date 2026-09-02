import type { MatchPlaySession, TeamMatchPlayCompetition } from '@ddga/types';
import { ScoringConfigError, ScoringInputError } from './errors';

/** Positional labels for the two sides of one match, in the order the config lists the teams. */
export type Side = 'a' | 'b';

export interface SideIdentity {
  readonly id: string;
  readonly name: string;
}

export interface MatchSides {
  readonly a: SideIdentity;
  readonly b: SideIdentity;
}

/** The two teams, in config order. Validation guarantees there are exactly two. */
export function resolveSides(config: TeamMatchPlayCompetition): MatchSides {
  const [first, second] = config.teams;
  if (first === undefined || second === undefined) {
    throw new ScoringConfigError(`Competition "${config.id}" does not define two teams.`);
  }
  return { a: first, b: second };
}

export interface PlayedHoleInput {
  readonly holeNumber: number;
  readonly type: 'strokes';
  readonly a: number;
  readonly b: number;
  /** A given putt still counts as holed, so this is for the audit trail, not the arithmetic. */
  readonly strokeConceded?: boolean;
}

export interface ConcededHoleInput {
  readonly holeNumber: number;
  readonly type: 'conceded';
  /** The side that gave the hole up. The other side wins it. */
  readonly concededBy: Side;
  /** 'self' when the conceding side entered it; 'opponent' when the side receiving it did. */
  readonly recordedBy: 'self' | 'opponent';
  /**
   * Strokes taken up to the concession. Only meaningful when the ruleset sets
   * `concessions.recordStrokes`. When it does not, a conceded hole carries no stroke count
   * at all.
   */
  readonly strokes?: { readonly a: number; readonly b: number };
}

export type MatchHoleInput = PlayedHoleInput | ConcededHoleInput;

export interface HoleOutcome {
  readonly holeNumber: number;
  readonly winner: Side | 'halved';
  readonly conceded: boolean;
  /** null for a conceded hole when the ruleset records no strokes — genuinely unscored. */
  readonly strokes: { readonly a: number; readonly b: number } | null;
  /** Positive means side A is up by this many after this hole. */
  readonly standingAfter: number;
  readonly holesRemainingAfter: number;
}

export interface MatchResult {
  /** null when the match was halved. */
  readonly winner: Side | null;
  /** Holes up at the finish. 0 for a halved match. */
  readonly margin: number;
  /** Holes left unplayed. Greater than zero only when the match closed out early. */
  readonly holesRemaining: number;
  readonly closedOut: boolean;
  /** Golf notation: "4&3" for a close-out, "2 up" gone the distance, "halved" for all square. */
  readonly notation: string;
  readonly points: { readonly a: number; readonly b: number };
}

export interface MatchProgress {
  readonly holeCount: number;
  readonly holes: readonly HoleOutcome[];
  readonly holesPlayed: number;
  readonly holesRemaining: number;
  /** Positive means side A is up by this many. */
  readonly standing: number;
  readonly leader: Side | null;
  /** The live display, in the ruleset's `statusFormat`. Becomes the result once decided. */
  readonly status: string;
  readonly decided: boolean;
  /** False once a decided match closes out — the app must stop asking for scores. */
  readonly acceptsScores: boolean;
  /** null while the match is still live. */
  readonly result: MatchResult | null;
}

export interface MatchInput {
  /** Holes scheduled for this match. Cup sessions here are nine. */
  readonly holeCount: number;
  readonly holes: readonly MatchHoleInput[];
}

function assertConcessionAllowed(
  hole: ConcededHoleInput,
  config: TeamMatchPlayCompetition,
): void {
  const { bySelf, byOpponent } = config.matchPlay.concessions.hole;
  if (hole.recordedBy === 'self' && !bySelf) {
    throw new ScoringInputError(
      `Hole ${hole.holeNumber}: this ruleset does not let a side concede its own hole.`,
    );
  }
  if (hole.recordedBy === 'opponent' && !byOpponent) {
    throw new ScoringInputError(
      `Hole ${hole.holeNumber}: this ruleset does not let a side record a hole conceded to them.`,
    );
  }
}

function assertStrokesUsable(hole: PlayedHoleInput, config: TeamMatchPlayCompetition): void {
  for (const side of ['a', 'b'] as const) {
    const strokes = hole[side];
    if (!Number.isInteger(strokes) || strokes < 1) {
      throw new ScoringInputError(
        `Hole ${hole.holeNumber}: side ${side} needs a whole stroke count of at least 1, received ${String(strokes)}.`,
      );
    }
  }
  if (hole.strokeConceded === true && !config.matchPlay.concessions.stroke.byOpponent) {
    throw new ScoringInputError(
      `Hole ${hole.holeNumber}: this ruleset does not allow conceded strokes.`,
    );
  }
}

/** "3 UP thru 14", or "AS thru 14" when all square. */
function liveStatus(standing: number, holesPlayed: number): string {
  return standing === 0
    ? `AS thru ${holesPlayed}`
    : `${Math.abs(standing)} UP thru ${holesPlayed}`;
}

function buildResult(
  standing: number,
  holesRemaining: number,
  closedOut: boolean,
  config: TeamMatchPlayCompetition,
): MatchResult {
  const { win, halved, loss } = config.pointsPerMatch;
  const margin = Math.abs(standing);

  if (standing === 0) {
    return {
      winner: null,
      margin: 0,
      holesRemaining,
      closedOut,
      notation: 'halved',
      points: { a: halved, b: halved },
    };
  }

  const winner: Side = standing > 0 ? 'a' : 'b';
  return {
    winner,
    margin,
    holesRemaining,
    closedOut,
    // A close-out reads "4&3"; a match that reached the last green reads "2 up".
    notation: closedOut ? `${margin}&${holesRemaining}` : `${margin} up`,
    points: {
      a: winner === 'a' ? win : loss,
      b: winner === 'b' ? win : loss,
    },
  };
}

/**
 * Play a match hole by hole.
 *
 * The match ends the moment one side leads by more holes than remain, which is why results
 * read "4&3" and why a nine-hole match can finish on the sixth green. Once that happens the
 * match stops accepting scores: submitting a further hole is an error rather than something
 * quietly ignored, because a score arriving for a finished match means something upstream is
 * wrong.
 */
export function playMatch(
  input: MatchInput,
  config: TeamMatchPlayCompetition,
): MatchProgress {
  if (!Number.isInteger(input.holeCount) || input.holeCount < 1) {
    throw new ScoringInputError(
      `A match needs at least one hole, received ${String(input.holeCount)}.`,
    );
  }
  if (input.holes.length > input.holeCount) {
    throw new ScoringInputError(
      `This match is scheduled for ${input.holeCount} holes but ${input.holes.length} were submitted.`,
    );
  }

  const seen = new Set<number>();
  const closeOutWhenDecided = config.matchPlay.closeOutWhenDecided;
  const recordStrokes = config.matchPlay.concessions.recordStrokes;

  const holes: HoleOutcome[] = [];
  let standing = 0;
  let decided = false;
  let decidedNotation = '';

  input.holes.forEach((hole, index) => {
    if (seen.has(hole.holeNumber)) {
      throw new ScoringInputError(`Hole ${hole.holeNumber} was submitted twice.`);
    }
    seen.add(hole.holeNumber);

    if (decided) {
      throw new ScoringInputError(
        `This match closed out ${decidedNotation} after ${index} holes; hole ${hole.holeNumber} cannot be scored.`,
      );
    }

    let winner: Side | 'halved';
    let strokes: { readonly a: number; readonly b: number } | null = null;

    if (hole.type === 'conceded') {
      assertConcessionAllowed(hole, config);
      if (hole.strokes !== undefined && !recordStrokes) {
        throw new ScoringInputError(
          `Hole ${hole.holeNumber}: a conceded hole is unscored under this ruleset, so it cannot carry a stroke count.`,
        );
      }
      winner = hole.concededBy === 'a' ? 'b' : 'a';
      strokes = recordStrokes ? (hole.strokes ?? null) : null;
    } else {
      assertStrokesUsable(hole, config);
      winner = hole.a < hole.b ? 'a' : hole.a > hole.b ? 'b' : 'halved';
      strokes = { a: hole.a, b: hole.b };
    }

    standing += winner === 'a' ? 1 : winner === 'b' ? -1 : 0;
    const holesRemainingAfter = input.holeCount - (index + 1);

    holes.push({
      holeNumber: hole.holeNumber,
      winner,
      conceded: hole.type === 'conceded',
      strokes,
      standingAfter: standing,
      holesRemainingAfter,
    });

    // "Decided" means decided *early*. A match won on the final green has no holes left to
    // skip, so it reads "1 up" rather than "1&0".
    if (
      closeOutWhenDecided &&
      holesRemainingAfter > 0 &&
      Math.abs(standing) > holesRemainingAfter
    ) {
      decided = true;
      decidedNotation = `${Math.abs(standing)}&${holesRemainingAfter}`;
    }
  });

  const holesPlayed = holes.length;
  const holesRemaining = input.holeCount - holesPlayed;
  const complete = decided || holesRemaining === 0;
  const result = complete ? buildResult(standing, holesRemaining, decided, config) : null;

  return {
    holeCount: input.holeCount,
    holes,
    holesPlayed,
    holesRemaining,
    standing,
    leader: standing === 0 ? null : standing > 0 ? 'a' : 'b',
    status: result === null ? liveStatus(standing, holesPlayed) : result.notation,
    decided,
    acceptsScores: !complete,
    result,
  };
}

// ---------------------------------------------------------------------------
// Session and cup totals
// ---------------------------------------------------------------------------

export interface SessionTotals {
  readonly roundId: string;
  readonly format: MatchPlaySession['format'];
  readonly matchesScheduled: number;
  readonly matchesComplete: number;
  readonly points: { readonly a: number; readonly b: number };
  /** Points actually awarded so far, across both sides. */
  readonly pointsAwarded: number;
  /** Points this session is worth once every match finishes. */
  readonly pointsAvailable: number;
}

/**
 * Add up one session. Every match awards the same total whoever wins it — validation rejects a
 * ruleset where a halved match creates or destroys points — so six matches are worth six
 * points however they finish.
 */
export function sessionTotals(
  session: MatchPlaySession,
  results: readonly (MatchResult | null)[],
  config: TeamMatchPlayCompetition,
): SessionTotals {
  if (results.length > session.matches) {
    throw new ScoringInputError(
      `Session "${session.roundId}" is configured for ${session.matches} matches but ${results.length} were supplied.`,
    );
  }

  const complete = results.filter((result): result is MatchResult => result !== null);
  const points = complete.reduce(
    (total, result) => ({ a: total.a + result.points.a, b: total.b + result.points.b }),
    { a: 0, b: 0 },
  );

  return {
    roundId: session.roundId,
    format: session.format,
    matchesScheduled: session.matches,
    matchesComplete: complete.length,
    points,
    pointsAwarded: points.a + points.b,
    pointsAvailable: session.matches * config.pointsPerMatch.win,
  };
}

export interface CupStanding {
  readonly points: { readonly a: number; readonly b: number };
  readonly pointsAwarded: number;
  readonly totalPointsAvailable: number;
  readonly pointsRemaining: number;
  readonly clinchThreshold: number;
  /** The side that has reached the clinch threshold, or null while the cup is still live. */
  readonly clinchedBy: Side | null;
  /** "6½ – 5½", the form the whiteboard uses. */
  readonly scoreline: string;
}

/** Halves are written as fractions, the way a Ryder Cup scoreboard does: 6.5 becomes "6½". */
export function formatMatchPoints(value: number): string {
  const whole = Math.floor(value);
  const isHalf = value - whole === 0.5;
  if (!isHalf) return String(value);
  return whole === 0 ? '½' : `${whole}½`;
}

/** Roll the sessions up into the cup score, and say whether it is already won. */
export function cupStanding(
  sessions: readonly SessionTotals[],
  config: TeamMatchPlayCompetition,
): CupStanding {
  const points = sessions.reduce(
    (total, session) => ({ a: total.a + session.points.a, b: total.b + session.points.b }),
    { a: 0, b: 0 },
  );

  const pointsAwarded = points.a + points.b;
  const clinchedBy: Side | null =
    points.a >= config.clinchThreshold ? 'a' : points.b >= config.clinchThreshold ? 'b' : null;

  return {
    points,
    pointsAwarded,
    totalPointsAvailable: config.totalPointsAvailable,
    pointsRemaining: config.totalPointsAvailable - pointsAwarded,
    clinchThreshold: config.clinchThreshold,
    clinchedBy,
    scoreline: `${formatMatchPoints(points.a)} – ${formatMatchPoints(points.b)}`,
  };
}
