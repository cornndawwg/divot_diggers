import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseRuleset,
  type IndividualTargetCompetition,
  type TeamMatchPlayCompetition,
} from '@ddga/types';

const ROOT = new URL('../../../', import.meta.url);

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, ROOT)), 'utf8'));
}

/** The dogfight competition from the real ruleset. The engine is driven by this, not by code. */
export function dogfightCompetition(): IndividualTargetCompetition {
  const ruleset = parseRuleset(readJson('divot-diggers-ruleset.json'));
  const dogfight = ruleset.competitions.find(
    (competition) => competition.type === 'individual_target',
  );
  if (dogfight === undefined || dogfight.type !== 'individual_target') {
    throw new Error('reference ruleset has no individual_target competition');
  }
  return dogfight;
}

export interface DogfightCase {
  readonly player: string;
  readonly input: {
    readonly startingPtp: number;
    readonly pointsPulled: readonly number[];
  };
  readonly expected: {
    readonly targetsByRound: readonly number[];
    readonly cumulativeDeltaByRound: readonly number[];
    readonly finalStanding: number;
    readonly carryoverRaw: number;
    readonly carryoverRounded: number;
    readonly position: number;
  };
}

export interface DogfightFixture {
  readonly fixtureId: string;
  readonly competition: string;
  readonly roundsInFixture: number;
  readonly note: string | null;
  readonly cases: readonly DogfightCase[];
}

export function loadDogfightFixture(year: number): DogfightFixture {
  return readJson(`fixtures/dogfight-${year}.json`) as DogfightFixture;
}

export interface FixtureManifest {
  readonly goldenYears: readonly number[];
  readonly fixtures: readonly { readonly file: string; readonly year: number; readonly cases: number }[];
}

export function loadManifest(): FixtureManifest {
  return readJson('fixtures/manifest.json') as FixtureManifest;
}

/** The cup competition from the real ruleset. */
export function cupCompetition(): TeamMatchPlayCompetition {
  const ruleset = parseRuleset(readJson('divot-diggers-ruleset.json'));
  const cup = ruleset.competitions.find((competition) => competition.type === 'team_match_play');
  if (cup === undefined || cup.type !== 'team_match_play') {
    throw new Error('reference ruleset has no team_match_play competition');
  }
  return cup;
}
