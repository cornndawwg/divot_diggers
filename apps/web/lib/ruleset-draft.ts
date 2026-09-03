import type { Ruleset } from '@ddga/types';

/**
 * The editor works on the ruleset document itself, not on a parallel form model.
 *
 * That is deliberate: the document is the storage format and the API contract, and the same
 * Zod schema that validates it on the server validates the draft here as the planner types.
 * A second shape in between is a second thing to keep in sync.
 *
 * The draft is loosely typed on purpose — a half-finished ruleset is not yet a valid one, and
 * the editor has to be able to hold an invalid state without crashing.
 */
export type Draft = Record<string, unknown>;

export interface TableRow {
  relativeToPar: number;
  label: string;
  points: number;
}

/** A starting point for a group with nothing yet. Neutral, not anyone's house rules. */
export function blankDraft(): Draft {
  return {
    rulesetId: 'house-rules',
    version: 1,
    name: 'House Rules',
    orgId: null,
    engineVersionMin: '1.0.0',
    scoringProfiles: [
      {
        id: 'points',
        name: 'Points per hole',
        basis: 'gross',
        table: [
          { relativeToPar: -2, label: 'Eagle', points: 4 },
          { relativeToPar: -1, label: 'Birdie', points: 3 },
          { relativeToPar: 0, label: 'Par', points: 2 },
          { relativeToPar: 1, label: 'Bogey', points: 1 },
        ],
        betterThanTable: { mode: 'clamp' },
        worseThanTable: { mode: 'value', points: 0 },
        specialRules: [],
        pickup: { policy: 'cap_at_first_zero', fixedRelativeToPar: null, recordCappedStrokes: true },
      },
    ],
    competitions: [
      {
        id: 'main',
        name: 'Main competition',
        type: 'individual_target',
        scoringProfile: 'points',
        rounds: ['round-1'],
        target: {
          label: 'Target',
          abbreviation: 'TGT',
          initialValue: {
            method: 'constant_minus_handicap',
            constant: 36,
            handicapSource: 'handicap_index',
            rounding: 'half_up',
          },
          carryover: 'none',
          carryoverRounding: 'half_up',
          adjustmentFactor: 0,
          adjustBetweenRounds: false,
          adjustAtEventEnd: false,
          runningTotal: 'cumulative',
          precision: 'full',
          displayPrecision: 0,
          prorateByHoles: false,
          holesPerFullRound: 18,
          didNotPlay: { ptp: 'freeze', standing: 'include', showOnLeaderboard: true },
          lapsedPlayer: {
            method: 'carry_unchanged',
            requirePlannerConfirmation: true,
            maxAdjustment: null,
            plannerMayEditSuggestion: true,
          },
        },
        eligibility: { minimumRoundsCompleted: 1 },
        standings: { sortBy: 'running_total', direction: 'desc' },
        tiebreak: { chain: [], fallback: { mode: 'planner_resolved', label: 'Playoff' } },
        payouts: [],
      },
    ],
    validation: {
      assertSessionMatchesSumToTotal: true,
      assertClinchExceedsHalfOfTotal: true,
      assertAllReferencedRoundsExist: true,
      assertAllReferencedProfilesExist: true,
    },
  };
}

/** Replace a value at a dotted path, without mutating the original. */
export function setPath(draft: Draft, path: string, value: unknown): Draft {
  const keys = path.split('.');
  const clone = structuredClone(draft) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (next === undefined || next === null) return clone;
    cursor = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) cursor[last] = value;
  return clone;
}

/** Read a value at a dotted path. */
export function getPath(draft: Draft, path: string): unknown {
  let cursor: unknown = draft;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** The first scoring profile, which is the one the editor exposes. */
export function profileOf(draft: Draft): Record<string, unknown> | undefined {
  const profiles = draft['scoringProfiles'];
  return Array.isArray(profiles) ? (profiles[0] as Record<string, unknown> | undefined) : undefined;
}

export function tableOf(draft: Draft): TableRow[] {
  const rows = profileOf(draft)?.['table'];
  return Array.isArray(rows) ? (rows as TableRow[]) : [];
}

/** The individual-target competition, if this ruleset has one. */
export function targetCompetitionOf(draft: Draft): Record<string, unknown> | undefined {
  const competitions = draft['competitions'];
  if (!Array.isArray(competitions)) return undefined;
  return competitions.find(
    (entry) => (entry as Record<string, unknown>)['type'] === 'individual_target',
  ) as Record<string, unknown> | undefined;
}

/** Sort the points table best score first, the way a scorecard reads. */
export function sortedTable(rows: readonly TableRow[]): TableRow[] {
  return [...rows].sort((a, b) => a.relativeToPar - b.relativeToPar);
}

/** A human label for a score relative to par, used when a row has no label yet. */
export function describeRelativeToPar(relativeToPar: number): string {
  if (relativeToPar === 0) return 'level par';
  if (relativeToPar > 0) return `${relativeToPar} over`;
  return `${Math.abs(relativeToPar)} under`;
}

export type { Ruleset };
