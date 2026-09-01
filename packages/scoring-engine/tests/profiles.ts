import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoringProfileSchema, type ScoringProfile } from '@ddga/types';

const REFERENCE_RULESET_PATH = fileURLToPath(
  new URL('../../../divot-diggers-ruleset.json', import.meta.url),
);

function referenceProfileJson(): Record<string, unknown> {
  const ruleset = JSON.parse(readFileSync(REFERENCE_RULESET_PATH, 'utf8')) as {
    scoringProfiles: Record<string, unknown>[];
  };
  const profile = ruleset.scoringProfiles[0];
  if (profile === undefined) throw new Error('reference ruleset has no scoring profiles');
  return structuredClone(profile);
}

/** The real Divot Diggers profile: 16/8/5/3/2/1, nothing below double bogey, ace rule off. */
export function divotDiggersProfile(): ScoringProfile {
  return scoringProfileSchema.parse(referenceProfileJson());
}

/** The same profile with the hole-in-one rule switched on. */
export function divotDiggersWithAceRule(): ScoringProfile {
  const json = referenceProfileJson() as { specialRules: { enabled: boolean }[] };
  const rule = json.specialRules[0];
  if (rule === undefined) throw new Error('reference profile has no special rules');
  rule.enabled = true;
  return scoringProfileSchema.parse(json);
}

/**
 * Every test profile below is authored here, in config, rather than in engine source.
 * If the engine needs changing to score one of them, invariant #1 is broken.
 */
function profile(overrides: Record<string, unknown>): ScoringProfile {
  return scoringProfileSchema.parse({
    id: 'test-profile',
    name: 'Test Profile',
    basis: 'gross',
    betterThanTable: { mode: 'clamp' },
    worseThanTable: { mode: 'value', points: 0 },
    pickup: { policy: 'cap_at_first_zero' },
    ...overrides,
  });
}

const DIVOT_DIGGERS_TABLE = [
  { relativeToPar: -3, label: 'Albatross', points: 16 },
  { relativeToPar: -2, label: 'Eagle', points: 8 },
  { relativeToPar: -1, label: 'Birdie', points: 5 },
  { relativeToPar: 0, label: 'Par', points: 3 },
  { relativeToPar: 1, label: 'Bogey', points: 2 },
  { relativeToPar: 2, label: 'Double Bogey', points: 1 },
];

/** A table that still pays at triple bogey. Its pickup cap must land one stroke later. */
export function paysToTripleBogeyProfile(): ScoringProfile {
  return profile({
    table: [...DIVOT_DIGGERS_TABLE, { relativeToPar: 3, label: 'Triple Bogey', points: 1 }],
  });
}

/** Standard Stableford: 5/4/3/2/1, nothing at double bogey or worse. */
export function stablefordProfile(): ScoringProfile {
  return profile({
    table: [
      { relativeToPar: -3, label: 'Albatross', points: 5 },
      { relativeToPar: -2, label: 'Eagle', points: 4 },
      { relativeToPar: -1, label: 'Birdie', points: 3 },
      { relativeToPar: 0, label: 'Par', points: 2 },
      { relativeToPar: 1, label: 'Bogey', points: 1 },
    ],
  });
}

/** A table whose own last row scores zero, rather than relying on worseThanTable. */
export function zeroInsideTableProfile(): ScoringProfile {
  return profile({
    table: [
      { relativeToPar: 0, label: 'Par', points: 3 },
      { relativeToPar: 1, label: 'Bogey', points: 2 },
      { relativeToPar: 2, label: 'Double Bogey', points: 0 },
    ],
  });
}

export function playOutProfile(): ScoringProfile {
  return profile({ table: DIVOT_DIGGERS_TABLE, pickup: { policy: 'play_out' } });
}

export function capAtFixedProfile(fixedRelativeToPar: number): ScoringProfile {
  return profile({
    table: DIVOT_DIGGERS_TABLE,
    pickup: { policy: 'cap_at_fixed', fixedRelativeToPar },
  });
}

export function clampBothEndsProfile(): ScoringProfile {
  return profile({
    table: DIVOT_DIGGERS_TABLE,
    worseThanTable: { mode: 'clamp' },
    pickup: { policy: 'play_out' },
  });
}

export function withSpecialRules(
  base: ScoringProfile,
  specialRules: Record<string, unknown>[],
): ScoringProfile {
  return scoringProfileSchema.parse({ ...base, specialRules });
}
