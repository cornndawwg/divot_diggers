import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REFERENCE_RULESET_PATH = fileURLToPath(
  new URL('../../../divot-diggers-ruleset.json', import.meta.url),
);

/** The real Divot Diggers ruleset, read from disk as unknown JSON — not a typed import. */
export function loadReferenceRuleset(): unknown {
  return JSON.parse(readFileSync(REFERENCE_RULESET_PATH, 'utf8'));
}

/**
 * A fresh mutable copy of the reference ruleset, cast to `any` so tests can corrupt
 * individual fields to prove the validator rejects them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function corruptibleRuleset(): any {
  return structuredClone(loadReferenceRuleset());
}
