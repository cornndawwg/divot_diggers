import { describe, expect, it } from 'vitest';
import { parseRuleset, safeParseRuleset } from '../src/index';
import { corruptibleRuleset, loadReferenceRuleset } from './helpers';

/** Assert a ruleset is rejected, and return the message so the test can inspect it. */
function rejectionMessage(input: unknown): string {
  const result = safeParseRuleset(input);
  expect(result.success, 'expected this ruleset to be rejected, but it validated').toBe(false);
  if (result.success) throw new Error('unreachable');
  return result.error.message;
}

describe('the reference ruleset', () => {
  it('validates', () => {
    expect(() => parseRuleset(loadReferenceRuleset())).not.toThrow();
  });

  it('parses into the values the spreadsheet and spec describe', () => {
    const ruleset = parseRuleset(loadReferenceRuleset());

    expect(ruleset.rulesetId).toBe('ddd-base');
    expect(ruleset.scoringProfiles).toHaveLength(1);
    expect(ruleset.competitions).toHaveLength(2);

    const profile = ruleset.scoringProfiles[0]!;
    expect(profile.table).toHaveLength(6);
    expect(profile.pickup.policy).toBe('cap_at_first_zero');
    // The hole-in-one rule exists but is off by default.
    expect(profile.specialRules[0]!.enabled).toBe(false);

    const dogfight = ruleset.competitions.find((c) => c.id === 'dogfight');
    expect(dogfight?.type).toBe('individual_target');
    if (dogfight?.type !== 'individual_target') throw new Error('unreachable');
    expect(dogfight.target.adjustmentFactor).toBe(0.5);
    expect(dogfight.target.carryoverRounding).toBe('half_up');
    expect(dogfight.target.precision).toBe('full');
    expect(dogfight.rounds).toEqual(['thu-am', 'fri-am', 'sat-am']);

    const cup = ruleset.competitions.find((c) => c.id === 'wrc');
    expect(cup?.type).toBe('team_match_play');
    if (cup?.type !== 'team_match_play') throw new Error('unreachable');
    expect(cup.totalPointsAvailable).toBe(24);
    expect(cup.clinchThreshold).toBe(13);
    expect(cup.sessions).toHaveLength(3);
    // The Cup deliberately references no scoring profile — see spec 1.3b.
    expect('scoringProfile' in cup).toBe(false);
  });
});

describe('Cup session arithmetic', () => {
  it('rejects a ruleset whose sessions do not sum to the declared total', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].totalPointsAvailable = 25;

    const message = rejectionMessage(ruleset);
    expect(message).toMatch(/24 point/);
    expect(message).toMatch(/25/);
    expect(message).toMatch(/totalPointsAvailable/);
  });

  it('rejects a dropped match just as readily as a wrong total', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].sessions[2].matches = 11; // 6 + 6 + 11 = 23, not 24

    const message = rejectionMessage(ruleset);
    expect(message).toMatch(/23 point/);
    expect(message).toMatch(/24/);
  });

  it('accepts a coherent 28-point cup', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].sessions[2].matches = 16; // 6 + 6 + 16 = 28
    ruleset.competitions[1].totalPointsAvailable = 28;
    ruleset.competitions[1].clinchThreshold = 15;

    expect(() => parseRuleset(ruleset)).not.toThrow();
  });

  it('rejects a clinch threshold that cannot actually clinch', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].clinchThreshold = 12; // 12 of 24 is a tie, not a win

    const message = rejectionMessage(ruleset);
    expect(message).toMatch(/clinchThreshold/);
    expect(message).toMatch(/12/);
  });
});

describe('cross-references', () => {
  it('rejects a competition pointing at a scoring profile that does not exist', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[0].scoringProfile = 'no-such-profile';

    const message = rejectionMessage(ruleset);
    expect(message).toMatch(/no-such-profile/);
  });

  it('rejects duplicate scoring profile ids', () => {
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles.push(structuredClone(ruleset.scoringProfiles[0]));

    expect(rejectionMessage(ruleset)).toMatch(/ddd-points/);
  });

  it('rejects the same round being used by two competitions', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].sessions[0].roundId = 'thu-am'; // already a dogfight round

    expect(rejectionMessage(ruleset)).toMatch(/thu-am/);
  });
});

describe('scoring profiles', () => {
  it('rejects two table rows for the same score relative to par', () => {
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles[0].table.push({ relativeToPar: 0, label: 'Par again', points: 9 });

    expect(rejectionMessage(ruleset)).toMatch(/relativeToPar/);
  });

  it('rejects an empty points table', () => {
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles[0].table = [];

    expect(rejectionMessage(ruleset)).toMatch(/table/);
  });

  it('rejects cap_at_fixed with no fixed value to cap at', () => {
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles[0].pickup.policy = 'cap_at_fixed';
    ruleset.scoringProfiles[0].pickup.fixedRelativeToPar = null;

    expect(rejectionMessage(ruleset)).toMatch(/fixedRelativeToPar/);
  });

  it('rejects cap_at_first_zero when no score can ever earn zero', () => {
    // If everything worse than the table clamps to 1 point instead of dropping to 0,
    // "cap at the first zero" has no boundary to find.
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles[0].worseThanTable = { mode: 'clamp' };

    expect(rejectionMessage(ruleset)).toMatch(/cap_at_first_zero/);
  });

  it('rejects net scoring with no handicap allocation configured', () => {
    const ruleset = corruptibleRuleset();
    ruleset.scoringProfiles[0].basis = 'net';

    expect(rejectionMessage(ruleset)).toMatch(/handicapAllocation/);
  });
});

describe('typo protection', () => {
  it('rejects an unknown field rather than silently ignoring it', () => {
    const ruleset = corruptibleRuleset();
    const target = ruleset.competitions[0].target;
    target.adjustmentFacter = 0.5; // misspelled
    delete target.adjustmentFactor;

    const message = rejectionMessage(ruleset);
    expect(message).toMatch(/adjustmentFac/);
  });

  it('rejects an adjustment factor outside 0 to 1', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[0].target.adjustmentFactor = 1.5;

    expect(rejectionMessage(ruleset)).toMatch(/adjustmentFactor/);
  });
});

describe('match play shape', () => {
  it('rejects anything other than two sides', () => {
    const ruleset = corruptibleRuleset();
    ruleset.competitions[1].teams.push({ id: 'c', name: 'Third Wheels' });

    expect(rejectionMessage(ruleset)).toMatch(/teams/);
  });
});
