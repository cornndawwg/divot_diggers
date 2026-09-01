import type { PointsTableRow, ScoringProfile } from '@ddga/types';
import { ScoringConfigError, ScoringInputError } from './errors';

function assertPlayableNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ScoringInputError(`${label} must be a number, received ${String(value)}.`);
  }
  if (!Number.isInteger(value)) {
    throw new ScoringInputError(`${label} must be a whole number, received ${value}.`);
  }
  if (value < 1) {
    throw new ScoringInputError(`${label} must be at least 1, received ${value}.`);
  }
}

/** Table rows sorted best score first. The schema guarantees at least one row. */
function sortedTable(profile: ScoringProfile): readonly PointsTableRow[] {
  return [...profile.table].sort((a, b) => a.relativeToPar - b.relativeToPar);
}

function bestRow(profile: ScoringProfile): PointsTableRow {
  const row = sortedTable(profile)[0];
  if (row === undefined) {
    throw new ScoringConfigError(`Scoring profile "${profile.id}" has an empty points table.`);
  }
  return row;
}

function worstRow(profile: ScoringProfile): PointsTableRow {
  const rows = sortedTable(profile);
  const row = rows[rows.length - 1];
  if (row === undefined) {
    throw new ScoringConfigError(`Scoring profile "${profile.id}" has an empty points table.`);
  }
  return row;
}

/**
 * Points for a score expressed relative to par, before special rules.
 *
 * Scores better than the table's best row and worse than its worst row are resolved by the
 * profile's `betterThanTable` / `worseThanTable` boundaries. Nothing about any particular
 * point value is known here — it all comes from the profile.
 */
export function pointsForRelativeToPar(relativeToPar: number, profile: ScoringProfile): number {
  const best = bestRow(profile);
  const worst = worstRow(profile);

  if (relativeToPar < best.relativeToPar) {
    const boundary = profile.betterThanTable;
    return boundary.mode === 'clamp' ? best.points : boundary.points;
  }

  if (relativeToPar > worst.relativeToPar) {
    const boundary = profile.worseThanTable;
    return boundary.mode === 'clamp' ? worst.points : boundary.points;
  }

  const row = profile.table.find((candidate) => candidate.relativeToPar === relativeToPar);
  if (row === undefined) {
    // Validation rejects tables with gaps, so this is a torn ruleset rather than a real score.
    throw new ScoringConfigError(
      `Scoring profile "${profile.id}" has no row for ${relativeToPar} relative to par.`,
    );
  }
  return row.points;
}

/**
 * How far over par a player may go before picking up, expressed relative to par.
 * `null` means the group plays every hole out.
 *
 * For `cap_at_first_zero` this is derived by walking outward from par until a score earns
 * nothing — so a table paying down to double bogey caps at par+3, and one paying down to
 * triple bogey caps at par+4, with no separate setting to keep in sync.
 */
export function pickupCapRelativeToPar(profile: ScoringProfile): number | null {
  const { policy, fixedRelativeToPar } = profile.pickup;

  if (policy === 'play_out') return null;

  if (policy === 'cap_at_fixed') {
    if (fixedRelativeToPar === null) {
      throw new ScoringConfigError(
        `Scoring profile "${profile.id}" uses pickup policy "cap_at_fixed" but sets no fixedRelativeToPar.`,
      );
    }
    return fixedRelativeToPar;
  }

  const highest = Math.max(0, worstRow(profile).relativeToPar) + 1;
  for (let relativeToPar = 0; relativeToPar <= highest; relativeToPar += 1) {
    if (pointsForRelativeToPar(relativeToPar, profile) === 0) return relativeToPar;
  }

  throw new ScoringConfigError(
    `Scoring profile "${profile.id}" uses pickup policy "cap_at_first_zero", but no score at or ` +
      'over par ever earns zero points, so there is no cap to derive.',
  );
}

/** The pickup cap as a stroke count on a hole of this par. `null` means no cap. */
export function pickupCapStrokes(par: number, profile: ScoringProfile): number | null {
  assertPlayableNumber(par, 'par');
  const cap = pickupCapRelativeToPar(profile);
  return cap === null ? null : par + cap;
}

/**
 * The score that goes on the card. A player who picks up records the capped score, which is a
 * real number on the card rather than a blank — see spec 1.2b.
 */
export function applyPickupCap(strokes: number, par: number, profile: ScoringProfile): number {
  assertPlayableNumber(strokes, 'strokes');
  assertPlayableNumber(par, 'par');

  const cap = pickupCapStrokes(par, profile);
  return cap === null ? strokes : Math.min(strokes, cap);
}

/**
 * Points scored on one hole.
 *
 * The cap is applied first, so the table and any special rules all read the same number — the
 * one written on the card. For a profile with `basis: "net"` the caller supplies net strokes;
 * stroke allocation happens upstream of this function.
 */
export function holePoints(strokes: number, par: number, profile: ScoringProfile): number {
  assertPlayableNumber(strokes, 'strokes');
  assertPlayableNumber(par, 'par');

  const recorded = applyPickupCap(strokes, par, profile);
  let points = pointsForRelativeToPar(recorded - par, profile);

  // The override layer sits above the table, in array order, so ordering is deterministic.
  for (const rule of profile.specialRules) {
    if (!rule.enabled) continue;
    if (rule.trigger.strokes !== recorded) continue;
    points = rule.effect.mode === 'override' ? rule.effect.points : points + rule.effect.points;
  }

  return points;
}
