import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRuleset,
  type MatchPlaySession,
  type TeamMatchPlayCompetition,
} from '@ddga/types';
import {
  cupStanding,
  formatMatchPoints,
  playMatch,
  resolveSides,
  sessionTotals,
  type MatchHoleInput,
  type MatchResult,
} from '../src/index';

const ruleset = parseRuleset(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../divot-diggers-ruleset.json', import.meta.url)),
      'utf8',
    ),
  ),
);

const cup: TeamMatchPlayCompetition = (() => {
  const found = ruleset.competitions.find(
    (competition) => competition.type === 'team_match_play',
  );
  if (found === undefined || found.type !== 'team_match_play') {
    throw new Error('reference ruleset has no team_match_play competition');
  }
  return found;
})();

const sessions = cup.sessions;

function session(roundId: string): MatchPlaySession {
  const found = sessions.find((entry) => entry.roundId === roundId);
  if (found === undefined) throw new Error(`no session ${roundId}`);
  return found;
}

/** Build hole entries where `winners` names the side that took each hole in turn. */
function holes(winners: readonly ('a' | 'b' | 'halved')[]): MatchHoleInput[] {
  return winners.map((winner, index) => ({
    holeNumber: index + 1,
    type: 'strokes' as const,
    a: winner === 'a' ? 4 : 5,
    b: winner === 'b' ? 4 : 5,
  }));
}

describe('the cup as configured', () => {
  it('is two sides over three sessions worth 24 points', () => {
    const sides = resolveSides(cup);
    expect(sides.a.name).toBe('Inglorious Bogies');
    expect(sides.b.name).toBe('Bad Birdies');
    expect(cup.totalPointsAvailable).toBe(24);
    expect(cup.clinchThreshold).toBe(13);
    expect(sessions.map((entry) => entry.matches)).toEqual([6, 6, 12]);
  });

  it('references no points table, because match play does not use one', () => {
    expect(cup).not.toHaveProperty('scoringProfile');
  });
});

describe('comparing holes', () => {
  it('awards the hole to the lower gross score', () => {
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'b', 'halved']) }, cup);
    expect(match.holes.map((hole) => hole.winner)).toEqual(['a', 'b', 'halved']);
    expect(match.standing).toBe(0);
  });

  it('tracks who is up and by how much', () => {
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'a', 'halved', 'b']) }, cup);
    expect(match.standing).toBe(1);
    expect(match.leader).toBe('a');
    expect(match.status).toBe('1 UP thru 4');
  });

  it('reads all square when nobody leads', () => {
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'b']) }, cup);
    expect(match.status).toBe('AS thru 2');
    expect(match.leader).toBeNull();
  });

  it('refuses a hole submitted twice', () => {
    expect(() =>
      playMatch(
        {
          holeCount: 9,
          holes: [
            { holeNumber: 1, type: 'strokes', a: 4, b: 5 },
            { holeNumber: 1, type: 'strokes', a: 4, b: 5 },
          ],
        },
        cup,
      ),
    ).toThrow(/submitted twice/i);
  });

  it('refuses more holes than the match is scheduled for', () => {
    expect(() => playMatch({ holeCount: 9, holes: holes(Array(10).fill('a')) }, cup)).toThrow(
      /scheduled for 9 holes/i,
    );
  });
});

describe('concessions, in both directions', () => {
  it('gives the hole away when a side concedes its own', () => {
    const match = playMatch(
      {
        holeCount: 9,
        holes: [{ holeNumber: 1, type: 'conceded', concededBy: 'b', recordedBy: 'self' }],
      },
      cup,
    );
    expect(match.holes[0]?.winner).toBe('a');
    expect(match.standing).toBe(1);
  });

  it('accepts a concession recorded by the side receiving it', () => {
    const match = playMatch(
      {
        holeCount: 9,
        holes: [{ holeNumber: 1, type: 'conceded', concededBy: 'a', recordedBy: 'opponent' }],
      },
      cup,
    );
    expect(match.holes[0]?.winner).toBe('b');
  });

  it('leaves a conceded hole genuinely unscored, not scored as a zero', () => {
    const match = playMatch(
      {
        holeCount: 9,
        holes: [{ holeNumber: 1, type: 'conceded', concededBy: 'b', recordedBy: 'self' }],
      },
      cup,
    );
    expect(match.holes[0]?.strokes).toBeNull();
    expect(match.holes[0]?.conceded).toBe(true);
  });

  it('refuses a stroke count on a conceded hole under this ruleset', () => {
    expect(() =>
      playMatch(
        {
          holeCount: 9,
          holes: [
            {
              holeNumber: 1,
              type: 'conceded',
              concededBy: 'b',
              recordedBy: 'self',
              strokes: { a: 4, b: 6 },
            },
          ],
        },
        cup,
      ),
    ).toThrow(/unscored under this ruleset/i);
  });

  it('refuses a self-concession when a ruleset forbids it', () => {
    const strict: TeamMatchPlayCompetition = {
      ...cup,
      matchPlay: {
        ...cup.matchPlay,
        concessions: {
          ...cup.matchPlay.concessions,
          hole: { byOpponent: true, bySelf: false },
        },
      },
    };
    expect(() =>
      playMatch(
        {
          holeCount: 9,
          holes: [{ holeNumber: 1, type: 'conceded', concededBy: 'b', recordedBy: 'self' }],
        },
        strict,
      ),
    ).toThrow(/concede its own hole/i);
  });
});

describe('closing out', () => {
  it('ends 4&3 when a side goes four up with three to play', () => {
    // Nine hole match: four up after six holes, three left.
    const match = playMatch(
      { holeCount: 9, holes: holes(['a', 'a', 'a', 'halved', 'halved', 'a']) },
      cup,
    );

    expect(match.decided).toBe(true);
    expect(match.result?.notation).toBe('4&3');
    expect(match.result?.winner).toBe('a');
    expect(match.result?.margin).toBe(4);
    expect(match.result?.holesRemaining).toBe(3);
    expect(match.status).toBe('4&3');
  });

  it('stops accepting scores once it has closed out', () => {
    const decided = playMatch(
      { holeCount: 9, holes: holes(['a', 'a', 'a', 'halved', 'halved', 'a']) },
      cup,
    );
    expect(decided.acceptsScores).toBe(false);

    expect(() =>
      playMatch(
        { holeCount: 9, holes: holes(['a', 'a', 'a', 'halved', 'halved', 'a', 'b']) },
        cup,
      ),
    ).toThrow(/closed out 4&3 after 6 holes; hole 7 cannot be scored/i);
  });

  it('does not close out at dormie, when the lead only equals the holes left', () => {
    // Three up with three to play: still live, because the other side can square it.
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'a', 'a', 'halved', 'halved', 'halved']) }, cup);
    expect(match.standing).toBe(3);
    expect(match.holesRemaining).toBe(3);
    expect(match.decided).toBe(false);
    expect(match.acceptsScores).toBe(true);
    expect(match.result).toBeNull();
  });

  it('reads "1 up" for a match won on the final green, not "1&0"', () => {
    const match = playMatch(
      { holeCount: 9, holes: holes(['halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'a']) },
      cup,
    );
    expect(match.holesPlayed).toBe(9);
    expect(match.result?.notation).toBe('1 up');
    expect(match.result?.closedOut).toBe(false);
    expect(match.result?.holesRemaining).toBe(0);
  });

  it('reads "halved" when the match finishes all square', () => {
    const match = playMatch(
      { holeCount: 9, holes: holes(['a', 'b', 'a', 'b', 'halved', 'halved', 'halved', 'halved', 'halved']) },
      cup,
    );
    expect(match.result?.notation).toBe('halved');
    expect(match.result?.winner).toBeNull();
    expect(match.result?.points).toEqual({ a: 0.5, b: 0.5 });
  });

  it('stays live at four up with five to play', () => {
    // Four up is not enough while five holes remain, so this match is still going.
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'a', 'a', 'a']) }, cup);
    expect(match.standing).toBe(4);
    expect(match.holesRemaining).toBe(5);
    expect(match.decided).toBe(false);
  });

  it('ends 5&4 on the fifth green, the earliest a nine-hole match can finish', () => {
    const match = playMatch({ holeCount: 9, holes: holes(['a', 'a', 'a', 'a', 'a']) }, cup);
    expect(match.holesPlayed).toBe(5);
    expect(match.result?.notation).toBe('5&4');
    expect(match.result?.closedOut).toBe(true);
  });

  it('plays every hole out when a ruleset says not to close out', () => {
    const playItOut: TeamMatchPlayCompetition = {
      ...cup,
      matchPlay: { ...cup.matchPlay, closeOutWhenDecided: false },
    };
    const match = playMatch(
      { holeCount: 9, holes: holes(['a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']) },
      playItOut,
    );
    expect(match.holesPlayed).toBe(9);
    expect(match.result?.notation).toBe('3 up');
  });
});

describe('a session', () => {
  const thursday = session('thu-pm');

  function sixMatches(): MatchResult[] {
    const outcomes: ('a' | 'b' | 'halved')[][] = [
      ['a', 'a', 'a', 'a', 'a'], // a wins 5&4
      ['b', 'b', 'b', 'b', 'b'], // b wins 5&4
      ['a', 'b', 'a', 'b', 'halved', 'halved', 'halved', 'halved', 'halved'], // halved
      ['halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'halved', 'a'], // a 1 up
      ['b', 'b', 'b', 'halved', 'halved', 'b'], // b wins 4&3
      ['a', 'a', 'halved', 'halved', 'halved', 'halved', 'halved', 'halved'], // a wins 2&1
    ];
    return outcomes.map((winners) => {
      const result = playMatch({ holeCount: thursday.holes, holes: holes(winners) }, cup).result;
      if (result === null) throw new Error('match did not finish');
      return result;
    });
  }

  it('is six matches of nine holes, two players a side', () => {
    expect(thursday.matches).toBe(6);
    expect(thursday.holes).toBe(9);
    expect(thursday.playersPerSide).toBe(2);
    expect(thursday.format).toBe('scramble');
  });

  it('awards six points across the two teams', () => {
    const totals = sessionTotals(thursday, sixMatches(), cup);
    expect(totals.matchesComplete).toBe(6);
    expect(totals.pointsAwarded).toBe(6);
    expect(totals.pointsAvailable).toBe(6);
    expect(totals.points.a + totals.points.b).toBe(6);
  });

  it('splits them the way the matches actually went', () => {
    const totals = sessionTotals(thursday, sixMatches(), cup);
    // a took 5&4, 1 up and 2&1; b took 5&4 and 4&3; one was halved.
    expect(totals.points).toEqual({ a: 3.5, b: 2.5 });
    expect(sixMatches().map((result) => result.notation)).toEqual([
      '5&4',
      '5&4',
      'halved',
      '1 up',
      '4&3',
      '2&1',
    ]);
  });

  it('awards a point per match however each one finishes', () => {
    const allHalved = Array.from({ length: 6 }, () => {
      const result = playMatch(
        {
          holeCount: 9,
          holes: holes(['a', 'b', 'a', 'b', 'halved', 'halved', 'halved', 'halved', 'halved']),
        },
        cup,
      ).result;
      if (result === null) throw new Error('match did not finish');
      return result;
    });
    const totals = sessionTotals(thursday, allHalved, cup);
    expect(totals.pointsAwarded).toBe(6);
    expect(totals.points).toEqual({ a: 3, b: 3 });
  });

  it('counts only the matches that have finished', () => {
    const totals = sessionTotals(thursday, [null, null, null, null, null, null], cup);
    expect(totals.matchesComplete).toBe(0);
    expect(totals.pointsAwarded).toBe(0);
  });

  it('refuses more matches than the session is configured for', () => {
    expect(() => sessionTotals(thursday, Array(7).fill(null), cup)).toThrow(
      /configured for 6 matches/i,
    );
  });
});

describe('the cup total', () => {
  function sessionWith(roundId: string, a: number, b: number) {
    return {
      roundId,
      format: session(roundId).format,
      matchesScheduled: session(roundId).matches,
      matchesComplete: session(roundId).matches,
      points: { a, b },
      pointsAwarded: a + b,
      pointsAvailable: session(roundId).matches * cup.pointsPerMatch.win,
    };
  }

  it('adds the sessions up and reports what is left', () => {
    const standing = cupStanding([sessionWith('thu-pm', 3.5, 2.5), sessionWith('fri-pm', 3, 3)], cup);
    expect(standing.points).toEqual({ a: 6.5, b: 5.5 });
    expect(standing.pointsAwarded).toBe(12);
    expect(standing.pointsRemaining).toBe(12);
  });

  it('writes halves the way the whiteboard does', () => {
    const standing = cupStanding([sessionWith('thu-pm', 3.5, 2.5), sessionWith('fri-pm', 3, 3)], cup);
    expect(standing.scoreline).toBe('6½ – 5½');
  });

  it('is not clinched at 12 all, because 12 is a tie', () => {
    const standing = cupStanding(
      [sessionWith('thu-pm', 3, 3), sessionWith('fri-pm', 3, 3), sessionWith('sat-pm', 6, 6)],
      cup,
    );
    expect(standing.pointsAwarded).toBe(24);
    expect(standing.clinchedBy).toBeNull();
  });

  it('is clinched the moment a side reaches 13', () => {
    const standing = cupStanding(
      [sessionWith('thu-pm', 4, 2), sessionWith('fri-pm', 4, 2), sessionWith('sat-pm', 5, 7)],
      cup,
    );
    expect(standing.points.a).toBe(13);
    expect(standing.clinchedBy).toBe('a');
  });

  it('can clinch before every match is finished', () => {
    const standing = cupStanding(
      [sessionWith('thu-pm', 6, 0), sessionWith('fri-pm', 6, 0), { ...sessionWith('sat-pm', 1, 0), matchesComplete: 1, pointsAwarded: 1 }],
      cup,
    );
    expect(standing.points.a).toBe(13);
    expect(standing.clinchedBy).toBe('a');
    expect(standing.pointsRemaining).toBe(11);
  });
});

describe('formatting points', () => {
  it('writes halves as fractions', () => {
    expect(formatMatchPoints(6.5)).toBe('6½');
    expect(formatMatchPoints(0.5)).toBe('½');
    expect(formatMatchPoints(12)).toBe('12');
    expect(formatMatchPoints(0)).toBe('0');
  });
});
