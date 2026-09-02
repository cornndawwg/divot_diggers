// Pure scoring functions, driven entirely by a ruleset document.
//
// No scoring constants live here — see invariant #1 in CLAUDE.md. Every point value, boundary,
// factor and threshold arrives as config. No I/O, no dates, no React, no network, and no
// runtime dependencies: the only imports are types, which erase at compile time.

export * from './errors';
export * from './rounding';
export * from './hole-points';
export * from './target';
export * from './standings';
export * from './eligibility';
export * from './lapsed-player';
export * from './match-play';
