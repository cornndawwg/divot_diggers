import { describe, expect, it } from 'vitest';
import {
  applyPickupCap,
  holePoints,
  pickupCapRelativeToPar,
  pickupCapStrokes,
} from '../src/index';
import {
  capAtFixedProfile,
  clampBothEndsProfile,
  divotDiggersProfile,
  divotDiggersWithAceRule,
  paysToTripleBogeyProfile,
  playOutProfile,
  stablefordProfile,
  withSpecialRules,
  zeroInsideTableProfile,
} from './profiles';

describe('the verification cases from BUILD-TASKS 1.3', () => {
  const profile = divotDiggersProfile();

  it('scores 3 for a 4 on a par 4', () => {
    expect(holePoints(4, 4, profile)).toBe(3);
  });

  it('scores 5 for a 3 on a par 4', () => {
    expect(holePoints(3, 4, profile)).toBe(5);
  });

  it('scores 0 for a 7 on a par 4', () => {
    expect(holePoints(7, 4, profile)).toBe(0);
  });

  it('scores 20 for an ace once the hole-in-one rule is on', () => {
    expect(holePoints(1, 4, divotDiggersWithAceRule())).toBe(20);
  });

  it('caps pickup at par+3 for the Divot Diggers table', () => {
    expect(pickupCapRelativeToPar(profile)).toBe(3);
    expect(pickupCapStrokes(4, profile)).toBe(7);
    expect(pickupCapStrokes(3, profile)).toBe(6);
    expect(pickupCapStrokes(5, profile)).toBe(8);
  });

  it('caps pickup at par+4 for a table that pays down to triple bogey', () => {
    const paysLower = paysToTripleBogeyProfile();
    expect(pickupCapRelativeToPar(paysLower)).toBe(4);
    expect(pickupCapStrokes(4, paysLower)).toBe(8);
  });
});

describe('table lookup', () => {
  const profile = divotDiggersProfile();

  it('reads every row of the table', () => {
    // par 5, so every relativeToPar from -3 to +2 is reachable
    expect(holePoints(2, 5, profile)).toBe(16); // albatross
    expect(holePoints(3, 5, profile)).toBe(8); // eagle
    expect(holePoints(4, 5, profile)).toBe(5); // birdie
    expect(holePoints(5, 5, profile)).toBe(3); // par
    expect(holePoints(6, 5, profile)).toBe(2); // bogey
    expect(holePoints(7, 5, profile)).toBe(1); // double
  });

  it('treats an ace on a par 3 as an eagle when the ace rule is off', () => {
    expect(holePoints(1, 3, profile)).toBe(8);
  });

  it('treats an ace on a par 4 as an albatross when the ace rule is off', () => {
    expect(holePoints(1, 4, profile)).toBe(16);
  });
});

describe('the table boundaries', () => {
  it('clamps a condor to the albatross value rather than inventing one', () => {
    // 1 on a par 5 is 4 under; the table stops at 3 under.
    expect(holePoints(1, 5, divotDiggersProfile())).toBe(16);
  });

  it('floors everything worse than the table at the configured value', () => {
    const profile = divotDiggersProfile();
    expect(holePoints(8, 5, profile)).toBe(0);
    expect(holePoints(20, 5, profile)).toBe(0);
  });

  it('can clamp at the worse end too, when that is what the config says', () => {
    // worseThanTable is "clamp", so a triple keeps the double bogey value of 1.
    const profile = clampBothEndsProfile();
    expect(holePoints(7, 4, profile)).toBe(1);
    expect(holePoints(12, 4, profile)).toBe(1);
  });
});

describe('special rules', () => {
  it('overrides the table value', () => {
    expect(holePoints(1, 3, divotDiggersWithAceRule())).toBe(20);
  });

  it('leaves other scores alone', () => {
    const profile = divotDiggersWithAceRule();
    expect(holePoints(3, 4, profile)).toBe(5);
    expect(holePoints(4, 4, profile)).toBe(3);
  });

  it('is inert while disabled', () => {
    expect(holePoints(1, 3, divotDiggersProfile())).toBe(8);
  });

  it('can add a bonus on top of the table instead of replacing it', () => {
    const profile = withSpecialRules(divotDiggersProfile(), [
      {
        id: 'ace_bonus',
        label: 'Ace bonus',
        enabled: true,
        trigger: { strokes: 1 },
        effect: { mode: 'add', points: 4 },
      },
    ]);
    // par 3 ace: eagle (8) plus the 4 point bonus
    expect(holePoints(1, 3, profile)).toBe(12);
  });

  it('applies rules in array order, so the last override wins', () => {
    const profile = withSpecialRules(divotDiggersProfile(), [
      {
        id: 'first',
        label: 'First',
        enabled: true,
        trigger: { strokes: 1 },
        effect: { mode: 'override', points: 20 },
      },
      {
        id: 'second',
        label: 'Second',
        enabled: true,
        trigger: { strokes: 1 },
        effect: { mode: 'add', points: 5 },
      },
    ]);
    expect(holePoints(1, 3, profile)).toBe(25);
  });
});

describe('the pickup cap is derived, never hardcoded', () => {
  it('lands at par+2 for a Stableford table', () => {
    expect(pickupCapRelativeToPar(stablefordProfile())).toBe(2);
  });

  it('uses a zero inside the table when there is one', () => {
    expect(pickupCapRelativeToPar(zeroInsideTableProfile())).toBe(2);
  });

  it('honours an explicit fixed cap', () => {
    expect(pickupCapRelativeToPar(capAtFixedProfile(5))).toBe(5);
    expect(pickupCapStrokes(4, capAtFixedProfile(5))).toBe(9);
  });

  it('reports no cap at all when the group plays every hole out', () => {
    expect(pickupCapRelativeToPar(playOutProfile())).toBeNull();
    expect(pickupCapStrokes(4, playOutProfile())).toBeNull();
  });
});

describe('applying the cap to a recorded score', () => {
  const profile = divotDiggersProfile();

  it('writes the capped score onto the card', () => {
    expect(applyPickupCap(9, 4, profile)).toBe(7);
  });

  it('leaves a score at or under the cap alone', () => {
    expect(applyPickupCap(7, 4, profile)).toBe(7);
    expect(applyPickupCap(5, 4, profile)).toBe(5);
  });

  it('does not cap when the group plays out', () => {
    expect(applyPickupCap(12, 4, playOutProfile())).toBe(12);
  });

  it('scores a capped hole the same as the raw one', () => {
    expect(holePoints(9, 4, profile)).toBe(holePoints(7, 4, profile));
  });
});

describe('rejecting nonsense input', () => {
  const profile = divotDiggersProfile();

  it('refuses a stroke count below one', () => {
    expect(() => holePoints(0, 4, profile)).toThrow(/strokes/i);
    expect(() => holePoints(-2, 4, profile)).toThrow(/strokes/i);
  });

  it('refuses a par below one', () => {
    expect(() => holePoints(4, 0, profile)).toThrow(/par/i);
  });

  it('refuses fractional strokes', () => {
    expect(() => holePoints(4.5, 4, profile)).toThrow(/whole number/i);
  });
});
