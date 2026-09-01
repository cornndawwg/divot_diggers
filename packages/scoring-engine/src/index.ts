// Pure scoring functions, driven entirely by a ruleset document.
//
// No scoring constants live here — see invariant #1 in CLAUDE.md. Every point value, boundary
// and threshold arrives as config. No I/O, no dates, no React, no network, and no runtime
// dependencies: the only import is a type, which erases at compile time.

export * from './errors';
export * from './hole-points';
