import { z } from 'zod';
import { identifierSchema, semverSchema } from './common';
import { competitionSchema, type Competition } from './competitions';
import { scoringProfileSchema } from './scoring-profile';

/**
 * Which cross-document assertions to run. All default to on: a ruleset that omits the block
 * gets the full set, because the safe default is to check more, not less.
 */
export const validationFlagsSchema = z.strictObject({
  assertSessionMatchesSumToTotal: z.boolean().default(true),
  assertClinchExceedsHalfOfTotal: z.boolean().default(true),
  assertAllReferencedRoundsExist: z.boolean().default(true),
  assertAllReferencedProfilesExist: z.boolean().default(true),
});

export type ValidationFlags = z.infer<typeof validationFlagsSchema>;

export const DEFAULT_VALIDATION_FLAGS: ValidationFlags = {
  assertSessionMatchesSumToTotal: true,
  assertClinchExceedsHalfOfTotal: true,
  assertAllReferencedRoundsExist: true,
  assertAllReferencedProfilesExist: true,
};

const rulesetShape = z.strictObject({
  rulesetId: identifierSchema,
  /** Rulesets are append-only: editing produces v(n+1) and never mutates v(n). Spec 1.4. */
  version: z.number().int().min(1),
  name: z.string().min(1),
  /** null means a system-owned preset any org can clone. Spec 1.5. */
  orgId: identifierSchema.nullable(),
  engineVersionMin: semverSchema,
  scoringProfiles: z.array(scoringProfileSchema).min(1, 'A ruleset needs at least one scoring profile.'),
  competitions: z.array(competitionSchema).min(1, 'A ruleset needs at least one competition.'),
  validation: validationFlagsSchema.optional(),
});

/** Every round id a competition claims, in document order. */
function roundsClaimedBy(competition: Competition): readonly string[] {
  return competition.type === 'individual_target'
    ? competition.rounds
    : competition.sessions.map((session) => session.roundId);
}

export const rulesetSchema = rulesetShape.superRefine((ruleset, ctx) => {
  const flags = ruleset.validation ?? DEFAULT_VALIDATION_FLAGS;

  // --- ids are unique -----------------------------------------------------
  const profileIds = new Set<string>();
  ruleset.scoringProfiles.forEach((profile, index) => {
    if (profileIds.has(profile.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoringProfiles', index, 'id'],
        message: `Duplicate scoring profile id "${profile.id}". Profile ids must be unique within a ruleset.`,
      });
    }
    profileIds.add(profile.id);
  });

  const competitionIds = new Set<string>();
  ruleset.competitions.forEach((competition, index) => {
    if (competitionIds.has(competition.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['competitions', index, 'id'],
        message: `Duplicate competition id "${competition.id}". Competition ids must be unique within a ruleset.`,
      });
    }
    competitionIds.add(competition.id);
  });

  // --- profile references resolve ------------------------------------------
  if (flags.assertAllReferencedProfilesExist) {
    ruleset.competitions.forEach((competition, index) => {
      if (competition.type !== 'individual_target') return;
      if (!profileIds.has(competition.scoringProfile)) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitions', index, 'scoringProfile'],
          message:
            `Competition "${competition.id}" references scoring profile "${competition.scoringProfile}", ` +
            `which this ruleset does not define. Available profiles: ${[...profileIds].join(', ') || 'none'}.`,
        });
      }
    });
  }

  // --- rounds belong to exactly one competition ----------------------------
  if (flags.assertAllReferencedRoundsExist) {
    const roundOwner = new Map<string, string>();
    ruleset.competitions.forEach((competition, index) => {
      const claimed = roundsClaimedBy(competition);
      const seenHere = new Set<string>();

      claimed.forEach((roundId, position) => {
        const path =
          competition.type === 'individual_target'
            ? ['competitions', index, 'rounds', position]
            : ['competitions', index, 'sessions', position, 'roundId'];

        if (seenHere.has(roundId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `Competition "${competition.id}" lists round "${roundId}" more than once.`,
          });
          return;
        }
        seenHere.add(roundId);

        const owner = roundOwner.get(roundId);
        if (owner !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              `Round "${roundId}" is claimed by both "${owner}" and "${competition.id}". ` +
              'A round belongs to one competition.',
          });
          return;
        }
        roundOwner.set(roundId, competition.id);
      });
    });
  }

  // --- cup arithmetic -------------------------------------------------------
  ruleset.competitions.forEach((competition, index) => {
    if (competition.type !== 'team_match_play') return;

    const teamIds = new Set<string>();
    competition.teams.forEach((team, teamIndex) => {
      if (teamIds.has(team.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitions', index, 'teams', teamIndex, 'id'],
          message: `Duplicate team id "${team.id}".`,
        });
      }
      teamIds.add(team.id);
    });

    const { win, halved } = competition.pointsPerMatch;
    if (halved * 2 !== win) {
      ctx.addIssue({
        code: 'custom',
        path: ['competitions', index, 'pointsPerMatch', 'halved'],
        message:
          `A halved match splits the win between both sides, so halved (${halved}) doubled should equal ` +
          `win (${win}). As configured, halving a match creates or destroys points.`,
      });
    }

    const matchCounts = competition.sessions.map((session) => session.matches);
    const totalMatches = matchCounts.reduce((sum, count) => sum + count, 0);
    const pointsFromSessions = totalMatches * win;

    if (flags.assertSessionMatchesSumToTotal && pointsFromSessions !== competition.totalPointsAvailable) {
      ctx.addIssue({
        code: 'custom',
        path: ['competitions', index, 'totalPointsAvailable'],
        message:
          `Cup sessions add up to ${pointsFromSessions} points ` +
          `(${matchCounts.join(' + ')} matches at ${win} point${win === 1 ? '' : 's'} per win) ` +
          `but totalPointsAvailable is declared as ${competition.totalPointsAvailable}. ` +
          'Fix the session match counts or the declared total before starting the event.',
      });
    }

    if (flags.assertClinchExceedsHalfOfTotal) {
      const half = competition.totalPointsAvailable / 2;
      if (competition.clinchThreshold <= half) {
        ctx.addIssue({
          code: 'custom',
          path: ['competitions', index, 'clinchThreshold'],
          message:
            `clinchThreshold of ${competition.clinchThreshold} cannot clinch a ` +
            `${competition.totalPointsAvailable}-point cup: ${half} points is a tie, so the threshold ` +
            `must be greater than ${half}.`,
        });
      }
    }
  });
});

export type Ruleset = z.infer<typeof rulesetSchema>;
