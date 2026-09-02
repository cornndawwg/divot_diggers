// Shared types and Zod schemas for the ruleset document.
//
// The ruleset is the only place scoring rules live — see invariant #1 in CLAUDE.md. These
// schemas are both the storage contract and the source the planner console generates its
// forms from, so a rule that cannot be expressed here does not exist.

export * from './ruleset/common.ts';
export * from './ruleset/scoring-profile.ts';
export * from './ruleset/competitions.ts';
export * from './ruleset/ruleset.ts';
export * from './ruleset/errors.ts';
export * from './ruleset/parse.ts';

// Course and scorecard modelling, plus the checksum suite from spec 2.3a.
export * from './course/index.ts';
