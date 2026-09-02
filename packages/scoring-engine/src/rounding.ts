import type { RoundingMode } from '@ddga/types';
import { ScoringConfigError } from './errors.ts';

/**
 * Rounding, stated explicitly for every mode.
 *
 * Invariant #3: never delegate this to a language or library default. `half_up` here means
 * half away from zero — 33.5 becomes 34, as fixtures/README.md documents — where several
 * common defaults round half to even and would return 32 for 32.5, 34 for 34.5 and 38 for
 * 37.5. Three players in the 2025 field land on exact halves, so the difference is not
 * hypothetical.
 *
 * Only carry-over and the display layer call this. Intermediate values inside the recurrence
 * are never rounded (invariant #2).
 */
export function applyRounding(value: number, mode: RoundingMode): number {
  if (!Number.isFinite(value)) {
    throw new ScoringConfigError(`Cannot round a non-finite value (${String(value)}).`);
  }

  switch (mode) {
    case 'half_up':
      // Ties away from zero.
      return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
    case 'half_down':
      // Ties toward zero.
      return value >= 0 ? Math.ceil(value - 0.5) : -Math.ceil(-value - 0.5);
    case 'half_even': {
      const floored = Math.floor(value);
      const remainder = value - floored;
      if (remainder !== 0.5) return Math.round(value);
      return floored % 2 === 0 ? floored : floored + 1;
    }
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
  }
}
