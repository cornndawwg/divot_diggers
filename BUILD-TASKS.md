# Build Tasks

Ordered task list for Claude Code. Work top to bottom. Each task ends with a **Verify** step you
can run and judge yourself without reading code.

Do not start a phase until the previous phase's gate passes.

---

## Phase 1 — Scoring engine (target: 5 weeks)

The hard part. No UI, no database, no network. When this phase is done, the math is provably
correct against nine years of real history and everything after it is plumbing.

### 1.1 Repo scaffold
Set up the pnpm monorepo, TypeScript strict, Vitest, and the workspace packages listed in
`CLAUDE.md`. Copy `fixtures/` in as read-only. Nothing else.

**Verify:** `pnpm install && pnpm test` runs and reports zero tests, no errors.

### 1.2 Ruleset types and validation
Zod schemas in `packages/types` for the ruleset document: scoring profiles, the points table,
special rules, pickup policy, and both competition types. Parse `divot-diggers-ruleset.json`.

**Verify:** `pnpm test` — the reference ruleset validates. A ruleset whose Cup sessions don't sum
to its declared total is **rejected** with a clear message.

### 1.3 Hole scoring
`holePoints(strokes, par, profile)`. Table lookup, clamp above, floor below, special-rule
override layer, and the pickup cap derived from the table rather than hardcoded.

**Verify:** `pnpm test` — a par 4 scores 3 for a 4, 5 for a 3, 0 for a 7. With the hole-in-one
rule on, a 1 scores 20. Pickup caps at par+3 for the Divot Diggers table and at par+4 for a table
that pays down to triple bogey.

### 1.4 The target recurrence
`applyRound()` and the round-over-round PTP adjustment, driven entirely by config.

**Verify:** `pnpm test` — all five golden years reproduce. **87 player-year cases, zero
failures.** This is the single most important gate in the project.

### 1.5 Carry-over
Year-end value, half-up rounding, DNP freeze, disqualification, and the lapsed-player suggestion.

**Verify:** `pnpm test` — `fixtures/ptp-carryover.json` passes at 35 of 41, with the six known 2021→2022
exceptions explicitly listed as planner-adjusted rather than silently ignored.

### 1.6 Prove the config abstraction
Author a Stableford ruleset from scratch and run the same engine against it.

**Verify:** `pnpm test` — Stableford scores correctly with **no changes to engine source**. If
any engine file had to change, invariant #1 is broken and the abstraction needs rework.

### 1.7 Match play
`team_match_play`: hole comparison, concessions both directions, close-out detection, session and
cup totals, clinch threshold.

**Verify:** `pnpm test` — a side 4 up with 3 to play closes out as "4&3" and stops accepting
scores. Six matches produce a session total of 6 points across the two teams.

> ### Gate 1 — do not proceed until this passes
> `pnpm test` is green, 87 dogfight cases and 35 carry-over transitions reproduce, and a
> Stableford ruleset runs on unmodified engine code.

---

## Phase 2 — Database and planner console (target: 6 weeks)

### 2.1 Schema and migrations
Port `docs/schema.sql` to Drizzle as migration 0001. It is already written and verified against a live
Postgres 16 — 27 tables, RLS policies, append-only ratings, ruleset immutability. Translate it
faithfully; do not redesign it. Drizzle does not model RLS policies or triggers, so those go in a
raw SQL migration alongside the table definitions.

**Verify:** `createdb golf && psql -d golf -f docs/schema.sql && psql -d golf -f docs/schema-tests.sql`
produces `rls_enabled_no_policy = 0` and the three expected ERRORs. Then the Drizzle migration
produces an identical schema.

### 2.2 Tenancy isolation
`docs/schema-tests.sql` already proves isolation at the database level. Port it to Vitest so it runs
in CI, and connect the API as the non-owning `app_user` role.

**Verify:** `pnpm test` — a test that authenticates as org B and reads org A's event **returns
zero rows**. Note that a table owner bypasses its own RLS; if the test passes while connected as
owner, the test is wrong, not the schema.

### 2.3 Auth
Better Auth: email + password, email verification, magic-link password reset. Roles are per-event
(planner, captain, player), and one person can hold several.

**Verify:** sign up, verify by email, sign in, reset a forgotten password — all in a browser.

### 2.4 Courses and tee sets
Manual entry: course, tee sets with rating and slope, per-hole par, yardage, stroke index. Plus
the checksum validator from `docs/rules-engine-spec.md` 2.3a, wired into every import path.

**Verify:** import `seed/caledonia.json`. All ten structural checks pass. Then corrupt one par
value and confirm the validator rejects it.

### 2.4a Scorecard photo import
Downscale on device, upload under a short-lived key, extract, run the checksum suite, present a
diff for approval. **Delete the image on approval or rejection**, plus a 48-hour bucket lifecycle
rule for abandoned jobs. Keep only the extracted JSON.

**Verify:** import a scorecard photo, approve it, then confirm the object is gone from storage and
`image_key` is null. The schema will reject a job left in `applied` while still holding an image.

### 2.4b Par-only quick entry
A course at `completeness = 'par_only'` must be immediately playable — no stroke index, no
yardage, no rating required.

**Verify:** add a new 9-hole course by tapping pars and start a round on it in **under 60
seconds**. This is the parking-lot test.

### 2.5 Rounds with explicit hole selection
Rounds reference a course, a tee set, and a hole selection (all 18, front 9, back 9, custom).

**Verify:** create an 18-hole dogfight round and a 9-hole Cup round on the same course. Each
displays the correct hole count and par total.

### 2.6 Event setup and roster
Create an event, add players with handicap index, seed PTP — carried over for returners,
`54 − index` for first-timers, with the lapsed-player suggestion screen.

**Verify:** build the 2026 event with all 24 players. Every starting PTP matches
`fixtures/dogfight-2026.json`.

### 2.7 Ruleset authoring UI
Forms generated from the Zod schemas. Includes a preview: enter a hypothetical scorecard, see the
computed points and target adjustment live.

**Verify:** edit the bogey value from 2 to 3 in the UI and watch the preview change. No JSON
visible anywhere.

### 2.8 Tee times and grouping
Planner enters tee times directly. Groupings can be auto-suggested by PTP (balanced, similar,
snake) or built by hand, then locked.

**Verify:** reproduce Thursday's six tee times and foursomes from the 2026 packet.

### 2.9 Retroactive round entry
Enter a round as point totals only, with no hole detail, for backfilling past events.

**Verify:** enter 2025 from `fixtures/dogfight-2025.json` as totals. Final standings match the
fixture exactly.

> ### Gate 2
> The 2025 and 2026 events exist in the database with real course data, and their standings match
> the fixtures. Org isolation tests pass.

---

## Phase 3 — Player scoring app (target: 6 weeks)

### 3.1 Expo app shell, auth, join by code
### 3.2 Score write queue
Online-first: the server is the source of truth and screens read from the API. Score entry goes
through one small local queue table that flushes immediately when connected and retries on
reconnect, foreground, and a timer. Cache the active round only — roughly fifty rows, not a
replica. No cursor-based delta sync, no client-side leaderboard computation.

**Verify:** enter three holes online — they appear server-side instantly. Then airplane mode,
enter six more, force-quit, reopen, restore signal. **All nine present, none duplicated.**

### 3.3 Idempotent flush
Mutations keyed on client-generated UUIDs so retries are free.

**Verify:** flush the same queue three times. No duplicate scores appear.

### 3.4 Scorecard entry
Renders exactly the holes in the round's selection, with real pars and stroke indexes. Large
touch targets, high contrast for sunlight. Gross strokes only — the app derives points.

**Verify:** enter a full round on a phone outdoors. Readable, and no mis-taps.

### 3.5 Group visibility and audit trail
Everyone in a tee group sees and can amend every group member's scores. Every entry stamps who
entered it. Tapping a score shows its history.

**Verify:** two phones in one group. A score entered on one appears on the other after sync,
attributed correctly.

### 3.6 Dogfight leaderboard
Polls the server. Shows `last updated 8:42 AM` rather than a spinner when the connection drops. DQ'd players appear greyed,
not hidden.

**Verify:** matches the calculated standings for a round entered by hand.

> ### Gate 3 — the real one
> **Play an actual round with four people using the app.** Not a simulation. Expect to find five
> things in eighteen holes that no amount of planning surfaces. Fix them before Phase 4.

---

## Phase 4 — Captains and the Cup (target: 5 weeks)

### 4.1 Live draft
Snake order, alternating captains, in-person at a table. Realtime here is worth it.

**Verify:** two devices, 24 players, a complete draft with no double-picks.

### 4.2 Matchup setting
Captains set the next round's matchups; locked the night before.

### 4.3 Pair suggestions
Balanced, similar, and snake strategies by PTP. Suggestions only — captains drag to adjust and
confirm. Never auto-commit.

### 4.4 Match card
A separate screen from the dogfight scorecard. Two columns, running "3 UP thru 14", concede
buttons for both sides, automatic close-out.

**Verify:** a match where one side goes 4 up with 3 to play ends automatically and reads "4&3".

### 4.5 Cup leaderboard
Running team totals with halves, plus a match-by-match strip.

**Verify:** matches the format on the 2026 whiteboard — "6½ / 5½" after two sessions.

---

## Phase 5 — Harden (target: 4 weeks)

- Battery profile over a 4½ hour round on the oldest phone in the group.
- Airplane-mode testing across every screen.
- Sunlight contrast and touch target audit.
- Planner override screens for when something goes wrong at 8 AM.
- Sentry, and an "export event to spreadsheet" escape hatch.
- Onboarding a 60-year-old can finish in a parking lot without help.

**Verify:** hand a phone to someone who has never seen the app. They get in and enter a score
with no verbal instructions.

---

## Phase 6 — Shadow run (the 2027 trip)

**Run the app and the whiteboard in parallel for the entire weekend.** Compare every number every
night. Do not retire the marker until 2028.

---

## Phase 7+ — Resale

Second pilot group on a genuinely different ruleset. Self-serve onboarding, preset ruleset
library, store listings, privacy policy. Then, much later, the social layer.
