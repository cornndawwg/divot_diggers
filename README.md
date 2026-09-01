# Golf Trip App — Handoff Package

Everything Claude Code needs to build this. Read in this order.

| File | What it's for |
|---|---|
| `CLAUDE.md` | **Start here.** Invariants, stack, conventions, glossary, and what not to build. |
| `BUILD-TASKS.md` | Ordered task list with a verification step for every task and gates between phases. |
| `docs/build-plan.md` | Architecture, hosting, offline design, roadmap, risks. |
| `docs/rules-engine-spec.md` | Scoring config schema, course and scorecard model, multi-tenancy. |
| `divot-diggers-ruleset.json` | The reference ruleset. The engine is tested against this. |
| `docs/schema.sql` | Postgres DDL with RLS. Verified against a live Postgres 16. |
| `docs/schema-tests.sql` | Asserts the schema's guarantees hold. Run after `docs/schema.sql`. |
| `seed/caledonia.json` | Real course data, extracted from the scanned card and validated. |
| `fixtures/` | Golden test data from nine years of spreadsheet history. Read-only. |

## The short version

Two competitions run at once over a four-day trip. The **Dogfight** is individual, scored on a
points-per-hole table against a per-player target called Points to Pull that persists across
years and self-adjusts by half of each round's delta. The **Winona Ryder Cup** is team match play
across three formats, 24 points, 13 to win.

None of that is hardcoded. Both are expressed as config so other groups can run their own rules.

## Decisions already made

- Private tool for one group first, multi-tenant product second — but tenancy is structural now.
- No scoring rules in code. Ever.
- Online-first. A local write queue protects score entry from signal drops; no full offline replica.
- Course data by manual entry or scorecard photo only. No GPS matching, no licensed feed yet.
- Scorecard photos are ephemeral — processed, approved, then deleted.
- No payments, no money owed, no settlement in the app.
- Email + password auth via Better Auth.
- Railway to start; portable architecture so the host stays a cheap decision.
- Target: working Dogfight **and** Cup at the August 2027 trip, run in parallel with the
  whiteboard for the whole weekend.

## The first gate

`pnpm test` reproducing 87 player-year cases from `fixtures/`. Nothing else matters until that
passes.
