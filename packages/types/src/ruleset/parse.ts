import { RulesetValidationError, toRulesetIssues } from './errors.ts';
import { rulesetSchema, type Ruleset } from './ruleset.ts';

export type RulesetParseResult =
  | { readonly success: true; readonly data: Ruleset }
  | { readonly success: false; readonly error: RulesetValidationError };

/** Validate a ruleset document without throwing. */
export function safeParseRuleset(input: unknown): RulesetParseResult {
  const result = rulesetSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: new RulesetValidationError(toRulesetIssues(result.error)) };
}

/** Validate a ruleset document, throwing a `RulesetValidationError` if it is not valid. */
export function parseRuleset(input: unknown): Ruleset {
  const result = safeParseRuleset(input);
  if (!result.success) throw result.error;
  return result.data;
}
