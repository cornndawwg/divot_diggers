# CLAUDE.md

Working agreement for Claude Code on this repository. Read this before writing any code.

## What this is

A mobile (iOS + Android) and web app for golf groups running multi-day resort trips. It scores
two simultaneous competitions: an individual **Dogfight** with a self-adjusting handicap called
Points to Pull, and a team **Ryder Cup**–style match play event.

Built first for one group (the Divot Diggers, 24 players, one event a year), then resold as a
multi-tenant product. Multi-tenancy is structural from commit one; the resale features are not.

**The person driving you is not a working developer.** They cannot review a diff and tell you
it's subtly wrong. Every task must end in a check they can run and judge — a passing test suite,
a screenshot, a number that matches a known value. If a task can't be verified that way, say so
and propose one that can, rather than proceeding.

## Non-negotiable invariants

These break silently and are expensive to find later. Violating any of them is a bug even if
tests pass.

1. **No scoring rules in code.** Point values, targets, adjustment factors, thresholds, and
   formats all come from a ruleset JSON document. If you find yourself typing `54`, `0.5`, `16`,
   `13`, or `24` into a source file, stop — it belongs in config. The engine must run a
   Stableford ruleset without modification.
2. **Full precision in the recurrence.** Targets are fractional in-trip (43.25, 14.375). Never
   round an intermediate value. Round only at the display layer, and only at year-end carry-over.
3. **Half-up rounding, explicitly.** `33.4 → 33`, `33.5 → 34`. JavaScript's `Math.round` is
   correct. Do not substitute a library default; several round half-to-even and will be wrong for
   roughly a quarter of the field. There are fixture cases that catch this.
4. **Never edit files in `fixtures/`.** They are extracted from nine years of real spreadsheet
   history and are the definition of correct. If a fixture seems wrong, stop and ask. Do not
   adjust a fixture to make a test pass.
5. **`organization_id` on every domain table, RLS on every table.** No exceptions. Write the
   adversarial test (org A cannot read org B) at the same time as the policy, not later.
6. **Rulesets are append-only and snapshotted onto events at start.** A running or completed
   event reads its snapshot, never the live ruleset. Otherwise historical results silently change.
7. **Online-first, but score writes never get lost.** The server is the source of truth. Score
   entry still goes through a local queue that retries on reconnect, because losing a score to a
   dropped bar of signal destroys trust in the whole app. Do not build a full offline replica.
8. **Sync mutations are idempotent on a client-generated UUID.** Replaying the queue must always
   be safe.
9. **Scorecard photos are ephemeral.** Downscale on device, delete once the import is approved or
   rejected, and never let one outlive its 48-hour expiry. Keep the extracted JSON, discard the
   pixels.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict mode, everywhere |
| Mobile | React Native + Expo (SDK 54+), EAS Build, EAS Update |
| Web | Next.js (planner console, leaderboards, big-screen mode) |
| API | Node + Hono, stateless |
| Database | Postgres (Railway to start), Drizzle ORM, plain SQL migrations |
| Auth | Better Auth — email + password, magic link for reset |
| Local storage | Expo SQLite + an outbox mutation queue |
| Assets | Cloudflare R2 behind a CDN. Never serve images through the API. |
| Tests | Vitest |
| Monorepo | pnpm workspaces |

Do not add a dependency without asking. Do not introduce a state management library, an ORM
other than Drizzle, or a UI kit without asking. Keep `packages/scoring-engine` at **zero runtime
dependencies**.

## Layout

```
apps/mobile          Expo app
apps/web             Next.js planner console + leaderboards
apps/api             Hono API
packages/scoring-engine   Pure functions. No I/O, no dates, no React, no network.
packages/types            Shared types + Zod schemas for ruleset config
packages/db               Drizzle schema + migrations
fixtures/                 Golden test data — READ ONLY
docs/                     Specs. Read before implementing a subsystem.
```

## Working agreement

- **Tests before implementation** for anything in `scoring-engine`. The fixtures already exist;
  write the test that loads them, watch it fail, then make it pass.
- **One task at a time**, in the order given in `BUILD-TASKS.md`. Finish and verify a task before
  starting the next. Do not scaffold ahead.
- **Small commits** with plain-English messages describing behavior, not files touched.
- **When a spec is ambiguous, ask.** Do not pick an interpretation and proceed. The specs in
  `docs/` were written by someone who knows the domain; a gap is more likely a question than an
  invitation to improvise.
- **When you finish a task, state the verification command and the expected result** so it can be
  checked without reading code.

## Domain glossary

| Term | Meaning |
|---|---|
| **Dogfight** | The individual competition running across the three morning rounds. |
| **PTP / Points to Pull** | A player's target score for a round. Persists across years and self-adjusts. Not a golf handicap. |
| **Points pulled** | Points a player actually scored in a round, summed from a per-hole table. |
| **Running total / delta** | Cumulative points above or below target across rounds. This is the standing. |
| **WRC / Winona Ryder Cup** | The team match play competition on the afternoon rounds. |
| **Pull** | To score points. "He pulled 47" means he scored 47 points. |
| **Handicap index** | Portable ability rating. Used only to seed a first-timer's PTP. |
| **Course handicap** | Index adjusted for a specific tee set's slope. **Not used** for PTP here. |
| **Scramble / Alternate shot / Singles** | The three Cup formats, one per day. |

## Reference documents

Read the relevant one before implementing a subsystem. Do not infer the rules from code.

- `docs/build-plan.md` — architecture, hosting, roadmap, risks
- `docs/rules-engine-spec.md` — scoring config schema, course model, multi-tenancy
- `divot-diggers-ruleset.json` — the reference ruleset, and the config the engine is tested against
- `fixtures/README.md` — what the golden data proves and its known caveats

## Things that are deliberately out of scope

Do not build these, even if they seem natural:

- Payment processing, money owed, or settlement of any kind. Handled off-app.
- A formula language or expression interpreter for rules. Use the strategy registry.
- A social feed or forum. Planned, but much later.
- Multi-region deployment.
- GHIN or handicap-service integration. Handicaps are entered manually.
- Realtime WebSockets before Phase 4. Polling is sufficient and simpler.
- A full offline replica, delta sync, or client-side leaderboard computation. Queue writes, cache
  the active round, nothing more.
- GPS course matching or a licensed course-data feed. Manual entry and photo import only.
- Long-term storage of scorecard images.
