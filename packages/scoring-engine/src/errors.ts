/** A score or par that cannot describe a real hole. */
export class ScoringInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringInputError';
  }
}

/**
 * A ruleset that parsed but cannot be scored. These should be unreachable for any profile that
 * passed validation in `@ddga/types`; they exist so a gap in validation surfaces loudly rather
 * than as a silently wrong number.
 */
export class ScoringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringConfigError';
  }
}
