import type { z } from 'zod';

export interface RulesetIssue {
  /** Dotted location in the document, e.g. `competitions.1.totalPointsAvailable`. */
  readonly path: string;
  readonly message: string;
}

function toDottedPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join('.');
}

export function toRulesetIssues(error: z.ZodError): RulesetIssue[] {
  return error.issues.map((issue) => ({
    path: toDottedPath(issue.path),
    message: issue.message,
  }));
}

/**
 * A plain-English summary. Planners never see JSON (spec 1.6), so this is what the authoring
 * UI and the CLI both render.
 */
export function formatRulesetIssues(issues: readonly RulesetIssue[]): string {
  const heading =
    issues.length === 1 ? 'Ruleset is not valid (1 problem):' : `Ruleset is not valid (${issues.length} problems):`;

  const lines = issues.map((issue) =>
    issue.path === '' ? `  - ${issue.message}` : `  - ${issue.path}: ${issue.message}`,
  );

  return [heading, ...lines].join('\n');
}

export class RulesetValidationError extends Error {
  readonly issues: readonly RulesetIssue[];

  constructor(issues: readonly RulesetIssue[]) {
    super(formatRulesetIssues(issues));
    this.name = 'RulesetValidationError';
    this.issues = issues;
  }
}
