# Divot Diggers App — Build Plan

Planning document for an iOS + Android app supporting resort golf trips with a season-long
dogfight and a Ryder Cup–style team competition.

Derived from: `DDD_Calibration2026.xlsx` (2018–2026 scoring history), `2026_DD_WRC_Packet.pdf`,
and the 2026 whiteboard leaderboard photo.

---

## 1. The rules engine, decoded

Everything else in this app is CRUD and plumbing. This section is the actual product. Get it
wrong and nobody trusts the app; get it right and the whiteboard goes away.

### 1.1 Points Pulled (per round, per player)

Each hole converts a gross score into points against par:

| Result | Points |
|---|---|
| Double bogey | 1 |
| Bogey | 2 |
| Par | 3 |
| Birdie | 5 |
| Eagle | 8 |
| Double eagle | 16 |

**Points Pulled** = sum across 18 holes.

**Open rule question (must resolve before coding):** triple bogey or worse is undefined in the
packet. Almost certainly 0, but it needs to be an explicitly configured value, not an assumption
buried in code. Same for a picked-up / no-score hole.

### 1.2 Points To Pull (PTP) — the handicap that isn't a handicap

This is the part that isn't in the packet, and it's the most important thing I found. PTP is a
**persistent, self-adjusting rating that carries across years**, not a per-trip calculation.

**New player, first trip:**

```
PTP = round(54 − course_handicap)
```

Verified against every 2026 first-timer: Sunil Patram (26 → 28), Zach Mangan (17 → 37),
Mike Sinkule (6.4 → 48), Larry Sinkule (9.5 → 45), Jack Denton (22 → 32), and the rest.

**Returning player:** PTP carries over from where they finished the previous year. Verified
against all twelve 2025 returnees — Justin Crumpler ended 2025 at 46 and started 2026 at 46,
Casey Wheeler 40 → 40, Levi Livermont 16 → 16, and so on. Their stated handicap is *ignored*
after year one.

### 1.3 The in-trip adjustment loop

Let `P₁` be the starting PTP, `pulled₁..₃` the points pulled each round, and `R₁..₃` the
running cumulative +/- shown on the board.

```
R₁ = pulled₁ − P₁
P₂ = P₁ + R₁ / 2

R₂ = pulled₂ − P₂ + R₁
P₃ = P₂ + (R₂ − R₁) / 2

R₃ = pulled₃ − P₃ + R₂
P_next_year = P₃ + (R₃ − R₂) / 2
```

In plain terms: after each round, half of that round's individual delta is baked back into your
PTP. Beat your number by 8 and your bar rises by 4 for tomorrow. The running total `R` is
cumulative, so a hot Thursday still counts on Saturday.

**Standings = final `R₃`, highest wins.** Payout to top three ($380 / $260 / $80).

Worked example, Jeff Dake 2026 (matches the whiteboard exactly):
`P₁ = 40`, Thurs 47 → `R₁ = +7`, `P₂ = 43.5`, Fri 43 → `R₂ = 43 − 43.5 + 7 = +6.5`,
`P₃ = 43.25`. The board shows `43.5 +7` then `43.3 +7` — displayed rounded, computed at full
precision. **Keep full precision internally; round only at render.** Rounding `P₂` to 43 or 44
would compound into a wrong PTP by Saturday and a wrong carry-in next year.

### 1.4 Winona Ryder Cup

- Two teams, drafted by captains the night before Round 1.
- 24 players → 12 per side.
- Round 1: 2-man scramble, match play. 6 matches, 1 pt win / ½ tie.
- Round 2: 2-man alternate shot, match play. 6 matches.
- Round 3: singles match play. 12 matches.
- **24 points total, 13 to win.** Tie → captains' sudden-death putting contest.

The whiteboard's `3½ / 2½` then `6½ / 5½` confirms this is tracked as a running cumulative team
total, not per-round.

### 1.5 Bugs in the current process that the app should structurally prevent

I found two real problems in the files you sent, and they're the business case for building this.

1. **The 2026 sheet is currently wrong.** Thursday's column matches the whiteboard for all 24
   players. Friday and Saturday do not — those cells still hold leftover values from the 2025
   sheet, row-shifted. Justin Crumpler's Friday reads 17 in the spreadsheet and 37 on the
   whiteboard. Kenny Adkins reads 28 vs. 21. Because PTP carries forward, **these errors will
   silently become every returning player's 2027 starting handicap** unless someone catches
   them. This is not a hypothetical data-integrity argument — it has already happened.

2. **A missed round is recorded as 0 points pulled.** Patrick Moulin's stale row ends at PTP 3;
   Jack Denton at 7. A player who skips Saturday shouldn't get their rating destroyed. The app
   needs an explicit `did_not_play` state that freezes PTP for that round rather than treating
   it as a catastrophic score.

Both of these are eliminated by making the scoring engine the only writer of derived values.

---

## 2. Product path: private first, resale second

**Decided.** Phase one is a private tool for the Divot Diggers. Once it's honed, it goes to the
App Store and Play Store as a multi-tenant product for other golf groups.

That sequencing is the right call — you get a real user base of 24 people who will tell you the
truth, on a real event, before a stranger ever pays you. But it changes what "private first"
means architecturally. These are not deferrable:

| Built from commit one | Deferred until resale |
|---|---|
| `organization_id` on every table, RLS everywhere | Billing / Stripe |
| Configurable rulesets (no hardcoded scoring) | Self-serve signup and onboarding |
| Shared course library with per-org overrides | Marketing site, support tooling |
| Global `people` identity, per-org membership | Store listings, screenshots, privacy policy |
| Ruleset versioning + per-event snapshots | Rule *authoring* UI polish |
| Per-org data export | Social / forum layer |

The left column is roughly two extra weeks of work now. Retrofitting any of it later is a
rewrite — particularly RLS and the ruleset system, which touch every query and every computation
respectively.

**No hardcoded point system.** Confirmed and taken as a hard requirement. The Divot Diggers
scoring rules become *data*, expressed in the same schema any other group would use. If your own
rules can't be expressed as config, the config isn't good enough. Full design in
`rules-engine-spec.md`.

**No payment processing, no cash-owed computation.** Settlement stays with the planners, outside
the app. This also keeps you clear of App Store Guideline 5.3 when you submit.

## 3. Tech stack

### Recommended

| Layer | Choice | Why |
|---|---|---|
| Mobile client | **React Native + Expo (SDK 54+), TypeScript** | One codebase, both platforms. |
| Distribution | **EAS Build + EAS Update** | OTA updates are the killer feature here. Find a scoring bug Thursday night at the Ailsa Pub, ship the fix before Friday's 8:04 tee time — no store review. |
| Backend | **Postgres + a Node/Hono API**, deployed on Railway | Your data is deeply relational — players → rounds → holes → matches → points. See §3.1 for the Railway-vs-BaaS tradeoff. |
| Local storage | **Expo SQLite**, one small write-queue table | Fallback only. See §4.2. |
| Scoring | **Pure TypeScript package**, zero dependencies | See §4. |
| Auth | **Better Auth — email + password**, magic link for reset, plus a 6-character event join code | Familiar to every user and expected for the resale product. Don't roll it yourself: hashing, sessions, verification, and reset flows are all easy to get subtly wrong. The magic-link reset path costs nothing extra since you're already sending email, and it keeps you from being tech support in a parking lot at 7 AM. |
| Push | Expo Notifications | "Matchups posted", "You're 2 holes behind on scoring" |
| Errors | Sentry | You get one weekend a year. You need to know what broke. |
| Repo | pnpm workspace monorepo | `apps/mobile`, `apps/admin`, `packages/scoring-engine`, `packages/types` |
| Web app | **Next.js, same monorepo, shared scoring engine** | Confirmed as a first-class surface, not an afterthought. Three jobs: the planner console (seeding rosters, authoring rules, building tee groups — laptop work, not thumb work), player access from a desktop, and a **big-screen leaderboard mode** you can cast to a TV at the Ailsa Pub. That last one is what literally replaces the whiteboard. |
| Rules storage | **JSONB rulesets + Zod-validated strategy registry** | No hardcoded scoring. See `rules-engine-spec.md`. |

### Considered and rejected

- **Flutter** — genuinely fine, and if you already know Dart, take it. Rejected only because
  TypeScript lets the scoring engine be *literally the same code* on client, server, and in
  tests. That shared-engine property is worth more here than any framework difference.
- **Firebase / Firestore** — great realtime story, poor fit for this data. Leaderboards need
  joins and aggregation across players, rounds, holes, and matches. You'd end up hand-rolling
  denormalization that Postgres does for free.
- **Native Swift + Kotlin** — two codebases for a 24-person annual event. No.
- **PowerSync or ElectricSQL** on top of Supabase — proper local-first sync engines, and a
  legitimate upgrade if the hand-rolled outbox gets painful. Adds cost and a dependency.
  Start simpler.

---

### 3.1 Hosting: Railway, and what it costs you

Railway is a good call for this. Usage-based pricing suits an app with one real weekend of
traffic a year — you pay near-nothing for the other fifty-one. Postgres, the API, and the web app
all deploy from the same repo, and there's no vendor lock-in to unwind later.

The thing to be deliberate about: **Railway is a deployment platform, not a backend-as-a-service.**
Choosing it over Supabase means you own four things Supabase hands you:

| | On Supabase | On Railway |
|---|---|---|
| Auth | Built in (OTP, magic link, sessions) | Better Auth or Lucia — ~1 week |
| Row Level Security | Postgres RLS + JWT claims, wired up | Enforce tenancy in the API layer, or wire RLS yourself |
| Realtime | Subscriptions over WebSocket, free | Your own WS server, or polling |
| File storage | Built in | Object storage, separately |

Three of those four are cheap to replace. **Realtime is the one worth thinking about, and the
answer is that you probably don't need it.** Your app is offline-first — the client renders
leaderboards from local SQLite and reconciles on sync. With 24 people on a golf course, a 10–15
second poll is indistinguishable from a push, and it's dramatically simpler to build, debug, and
reason about offline. Don't buy a realtime platform to solve a problem polling already solves.
Add WebSockets later for the two places latency actually shows: the live draft and an active
match-play scoreboard.

**On the egress cost you're worried about:** the structured data here is trivially small. A full
scorecard is a couple of KB; a 24-person event for a whole weekend is well under a megabyte.
Thousands of users would not move the needle. What *does* generate egress is images — profile
photos, scorecard-import photos, and eventually the social layer.

One decision defuses that entirely: **put every blob on object storage behind a CDN from day
one, and never serve an image through the app server.** Cloudflare R2 charges zero egress fees,
which turns your main scaling cost risk into a rounding error. Do this in Phase 2, not when the
bill arrives.

**Keep the database portable.** Use Drizzle with plain SQL migrations, avoid vendor-specific
extensions, and keep auth and any realtime behind thin interfaces. Then moving between Railway,
Neon, RDS, or a managed Supabase later is a weekend of work rather than a rewrite — which is the
real reason to start on Railway rather than agonizing about the endgame now.

### 3.2 Where it goes when it scales

Short answer: **don't pick the scale host now — pick a portable architecture, and the decision
stays cheap forever.** What locks you in is never the host, it's the managed services you lean
on. Stateless containers, plain Postgres, and S3-compatible storage move between every provider
below with no code change.

That said, here's the target to grow into, layer by layer.

**Database — Neon.** Serverless Postgres that scales to zero. This is close to a perfect fit for
your traffic shape: golf events cluster into summer weekends, so you're near-idle for most of the
year and spiky for a few days at a time. You pay for the spike instead of provisioning for it.
Branching also gives you a real staging database per pull request, which matters once the scoring
engine has customers depending on it. Alternatives: Supabase (managed Postgres, if you later want
its auth back), or RDS/Aurora Serverless v2 if you end up in AWS anyway.

**API — Render or Fly.io.** Both are Railway-shaped, so the migration is a Dockerfile and
environment variables. Render is the boring choice with better autoscaling and managed
everything. Fly is better if latency ever matters, since it runs instances near users. Keep the
API **stateless** — no in-memory session or job state — and this stays a one-day move.

**Assets — Cloudflare R2 + CDN.** Zero egress fees. This is the piece to adopt immediately rather
than at scale, because it's the only layer where your cost concern is real.

**Realtime, when you actually need it.** Ably or Pusher managed if you want it to just work;
Cloudflare Durable Objects if you want it cheap and are willing to build. Only two features need
it — the live draft and an in-progress match-play scoreboard. Everything else polls.

**Multi-region is almost certainly unnecessary.** Golf groups are regional. A single US region
behind a CDN serves a very large number of users before geography becomes the bottleneck. Don't
pay the complexity tax early.

### 3.3 The thing that actually determines whether it scales

Not the host — **the sync endpoint.** With offline-first clients, every phone coming back into
signal on the 9th tee fires a sync, and at scale that's your hot path. Three properties to build
in from the first version:

- **Batched.** One request carrying every queued mutation, not one request per mutation. A
  foursome finishing a round should produce four syncs, not four hundred.
- **Idempotent, keyed on client-generated UUIDs.** Replays must be free. This is what makes
  aggressive retry safe on bad connections.
- **Cursor-based pull.** The client sends "last seen version N," the server returns only the
  delta. Never re-send a full event payload.

Get those three right and the API is cheap to run at almost any size, on almost any host. Get
them wrong and no amount of infrastructure saves you.

### 3.4 Handoff package

The person driving Claude Code is not a working developer, which changes what the documentation
has to do. It can't rely on diff review to catch mistakes; verification has to be mechanical.
Every task in `../BUILD-TASKS.md` therefore ends in a command with a judgeable result, and the golden
fixtures act as the acceptance gate — 87 player-years of real history either reproduce or they
don't.

`../CLAUDE.md` carries the invariants that break *silently*: full precision in the recurrence,
half-up rounding, no scoring constants in source, RLS on every table, fixtures are read-only.
Those are the failures that pass tests and surface a year later as a wrong PTP.

**Test data and seed data are separate.** Engine fixtures keep all five played years (2019, 2021,
2023, 2025, 2026) because more cases catch more bugs and it costs nothing. Production data seeds
from 2025 and 2026 only. 2018, 2022, and 2024 have no surviving scores and are out of scope.

## 4. Architecture

### 4.1 The scoring engine is a pure library

Single most important structural decision.

```
packages/scoring-engine/
  holePoints(strokes, par, config) -> number
  roundPoints(scorecard, config)   -> number
  applyRound(ptp, pulled, priorR)  -> { newPtp, newR }
  dogfightStandings(players[])     -> LeaderboardRow[]
  matchPlayResult(scoreA, scoreB)  -> 'A' | 'B' | 'halved'
  cupStandings(matches[])          -> { teamA: number, teamB: number }
```

Pure functions. No network, no database, no React, no dates. Properties this buys you:

- **The client computes leaderboards offline** and the server recomputes identically on sync.
  Same code, same answer, no drift.
- **You can test it against nine years of real data.** Export every scoring tab from
  `DDD_Calibration2026.xlsx` to JSON fixtures and assert the engine reproduces 2018 through 2025
  exactly. Do this *first*, before any UI exists. If the engine can't reproduce Ed Pierce's 2003
  season and Casey Wheeler's 2025 run, nothing built on top of it matters.
- Rule changes become a config object plus a new fixture, not a refactor.

### 4.2 Online-first, with a write queue as the fallback

The app assumes connectivity. The server is the source of truth, screens read from the API, and
leaderboards poll. That's the normal path and it should feel like a normal app.

But there is one failure that would kill adoption, and it costs almost nothing to prevent: **a
score entered on the 14th tee must never be lost because a bar of signal dropped.** Lose a man's
birdie once and he goes back to a pencil for the rest of the weekend.

So the fallback is deliberately narrow:

- **Score writes go to a small local queue first**, then flush. With signal, the flush is
  immediate and the queue is invisible. Without it, entries hold and retry on reconnect,
  foreground, and a timer. This is not extra work — it replaces the error handling you'd
  otherwise scatter across every screen.
- **Mutations are idempotent on a client-generated UUID.** Retrying a flush is always free.
- **Cache only the active round** — your group's scorecard and hole scores, on the order of fifty
  rows. Not a replica of the event.
- **Unsynced holes show a small pending marker**, and the leaderboard shows
  `last updated 8:42 AM` rather than a spinner, when the connection is out.
- **Conflicts resolve last-write-wins per (player, round, hole)** with an audit trail. For
  twenty-four friends this is correct. Do not build CRDTs.

**What this drops, relative to a true offline-first build:** no full local database replica, no
cursor-based delta sync, no client-side leaderboard computation, no offline course library. That
is roughly three to four weeks of work removed from Phase 3, and it's the right trade for a
first version.

The one place to stay honest: Caledonia is 45–55 minutes out at Pawleys Island and coverage is
uneven. Test the queue in airplane mode anyway.

### 4.3 Data model sketch

```
organizations
events                (org_id, name, year, join_code)
courses               (name, address)
course_tees           (course_id, tee_name, rating, slope)
holes                 (course_tee_id, number, par, stroke_index, yardage)
rounds                (event_id, course_tee_id, date, format, round_number)

people                (name, email, phone)              -- identity across years
player_ratings        (person_id, org_id, ptp, effective_after_event_id)
                      -- THE carry-over table. Immutable history, never overwrite.
event_players         (event_id, person_id, handicap_index, starting_ptp)

tee_groups            (round_id, tee_time)
tee_group_members     (tee_group_id, event_player_id)

scorecards            (round_id, event_player_id, status, did_not_play)
hole_scores           (scorecard_id, hole_number, strokes, entered_by,
                       client_uuid, updated_at)

cup_teams             (event_id, name, captain_person_id)
cup_team_members      (cup_team_id, event_player_id, draft_pick_number)
cup_matches           (round_id, cup_team_a, cup_team_b, format, status)
cup_match_players     (cup_match_id, event_player_id, side)
cup_match_holes       (cup_match_id, hole_number, side_a_score, side_b_score)
cup_match_results     (cup_match_id, winner, points_a, points_b)
```

Two notes worth internalizing:

- **`people` is separate from `event_players`.** PTP carries across years, so a person needs an
  identity that outlives any one trip. This is the schema-level fix for your carry-over logic.
- **`player_ratings` is append-only.** You should be able to answer "what was Kyle Holbrook's PTP
  going into 2023, and what changed it" forever. Never UPDATE a rating; INSERT a new one.

### 4.4 Roles

Roles are per-event, not global. Justin Crumpler is a captain *and* a player *and* possibly the
planner. One person, three hats, same login.

- **Planner** — full write on event config, rules, rounds, tee groups, rosters, manual score
  override.
- **Captain** — draft picks during an active draft window; set matchups for the next round;
  read-only on everything else.
- **Player** — enter scores for their own scorecard; enter scores for others in their tee group
  (see below); read all leaderboards.

### 4.5 Group scoring and accountability

Your accountability requirement, made concrete:

- Everyone in a tee group sees every group member's hole-by-hole entries live.
- Any group member can enter or amend any score in the group — the honor system with a paper
  trail, which is how it already works with a pencil.
- Every entry stamps `entered_by`. A tap on any score shows "Jeff Dake entered 5 at 9:14 AM,
  changed to 6 by Mike Sinkule at 9:15 AM." Visible, not hidden in a log.
- Optional **hole gate**: nobody advances past hole N until all four scores are in. Make it a
  toggle — great for accountability, mildly annoying when someone's phone dies. Let the planner
  decide.
- Enter **gross strokes**, never points. The app derives points. This is where auto-scoring
  earns its keep: no more arithmetic errors on the cart, and the whiteboard math disappears.

### 4.6 Pair generation

"Click to pair based off handicaps" needs a defined strategy, and different formats want
different ones:

- **Balanced (A/B split)** — sort by PTP, split at the median, pair strongest with weakest. Makes
  even teams. Right for alternate shot.
- **Snake draft order** — 1-2-2-1 across captains. Right for the draft itself.
- **Similar** — pair adjacent PTPs. Right for competitive singles matchups.
- **Manual override always available**, because the algorithm doesn't know Larry and Mike are
  brothers or that two guys had an argument at the pub.

Implement as a strategy function returning *suggestions*, then let the captain drag to adjust and
confirm. Never auto-commit a pairing.

### 4.7 Live leaderboards

Three distinct boards, matching your whiteboard's layout:

1. **Dogfight** — individual. Columns: Player, PTP, R1/R2/R3 pulled, running +/-, position.
   Sorted by cumulative +/-. This is the bottom two-thirds of your board.
2. **Winona Ryder Cup** — team totals with the running `X½ / Y½`, plus a match-by-match strip
   showing "3 UP thru 14". This is the header of your board.
3. **Round detail** — live within a single round, per tee group.

Implementation: Postgres views or materialized views, pushed over Supabase Realtime. Client
renders from local state and reconciles on push. Add a "projected finish" for the dogfight that
extrapolates incomplete rounds — cheap to build, and it's the thing people will actually stare at
on the 15th green.

---

## 5. Roadmap

You just finished the 2026 trip. Next event is late August 2027 — roughly twelve months. That is
a comfortable runway for part-time work, and it gives you a hard, real deadline, which is worth
more than any project management tool.

### Phase 0 — Rules lock (1 week, no code)

Mostly done — see the resolved table in `rules-engine-spec.md`. Close the three remaining opens,
then **express the Divot Diggers rules as a ruleset config document** — not prose. If your own rules don't fit the schema,
the schema is wrong, and you want to learn that now. Get the other organizers to sign off.
**Ambiguity found here costs an hour; found in August 2027 it costs the weekend.**

### Phase 1 — Scoring engine + ruleset schema (5 weeks)

Pure TypeScript package, plus the strategy registry and Zod config schemas. Export 2018–2026 from
the spreadsheet as JSON fixtures. Write tests first, then the engine, until every historical year
reproduces exactly **while driven entirely by config** — no Divot Diggers constants in the code.
Add a Stableford ruleset as a second fixture to prove the abstraction holds. No UI.

### Phase 2 — Web planner console + course library (6 weeks)

Supabase project, schema, **RLS policies with adversarial tests**. Course and tee-set model with
manual entry. Ruleset authoring forms. Create an event, import 24 players with handicap indexes,
seed PTPs from the corrected 2026 finals, build tee groups and rounds with explicit hole
selection. Deliverable: the 2026 event fully reconstructed from real course data, with final
standings matching your archive.

### Phase 3 — Player scoring (6 weeks)

Mobile app: join by code, see your tee group, enter hole scores, offline queue, sync, dogfight
leaderboard. Ship to TestFlight. **Then go play a real round with four people and use it.** Not a
simulation — an actual round. You'll find five things in eighteen holes that no amount of planning
surfaces.

### Phase 4 — Captains and the Cup (5 weeks)

Live draft (realtime, with a pick timer — it's a bar, people wander off), matchup setting, pair
suggestions, match play scoring, cup leaderboard.

### Phase 5 — Harden (4 weeks)

Battery profiling over 4+ hours. Airplane-mode testing. Sunlight-readable contrast and large
touch targets — this is a real design constraint, not polish. Planner override screens for when
something goes wrong at 8 AM. Sentry. Onboarding that a 60-year-old can complete in the parking
lot without help.

### Phase 6 — Shadow run (the 2027 trip)

**Run the app and the whiteboard in parallel for the whole weekend.** Do not retire the
whiteboard. Compare every number every night. This is how you earn trust, and it's how you find
the last bugs. Retire the marker in 2028.

### Phase 7 — Resale readiness (post-2027 trip)

Second pilot group on a genuinely different ruleset — this is the real test of the config system,
and you want to fail it with a friendly group rather than a paying one. Self-serve onboarding,
preset ruleset library, store listings, privacy policy, support process. Submit.

### Phase 8 — Social layer (later still)

Per-org feed, event threads, impromptu-round posts with RSVPs. Scoped down from a general forum.
See Part 4 of `rules-engine-spec.md` for why this should stay out of your *first* store
submission specifically, not just out of the MVP.

Total: roughly 28 weeks of focused effort through the 2027 shadow run. At 10 hours a week that
lands in early summer 2027 with slack to spare. Resale work happens after you've run a real event
on it.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Losing a score to a signal drop** | Local write queue with idempotent retry. Narrow, cheap, and the one offline case that matters. |
| **Battery** | 4+ hours of intermittent screen use. Test on the oldest phone in the group. Minimize wake locks, batch sync, no polling loops. |
| **Adoption** | 24 guys with a working paper system. Shadow run for a full year. One person who can't get in on Thursday morning poisons the whole trip. |
| **App Store Guideline 5.3 (gambling)** | You have $60 wagers and cash payouts. Tracking points is fine. **Do not process payments, do not compute cash owed, do not integrate Venmo.** If you ever go to the public App Store, keep money entirely out of the app. Under TestFlight/internal distribution this is a non-issue — another reason to stay private. |
| **Over-engineering the rules system** | Parameterized strategies, not a formula language. Ship two strategies, add more on demand. |
| **UGC obligations from the social layer** | Guideline 1.2 requires EULA, filtering, reporting, blocking, 24h response. Keep it out of the first submission. |
| **RLS gaps leaking data between orgs** | Adversarial policy test suite from Phase 2, not Phase 7. Silent failure mode. |
| **Egress cost at scale** | Blobs on R2/CDN from day one, never through the app server. Structured data volume is negligible. |
| **Data loss** | Append-only ratings, daily Supabase backups, and a "export event to spreadsheet" button so there's always a paper-compatible escape hatch. |

---

## 7. First three things to do

1. Confirm the 2026 final numbers and lock the corrected 2027 starting PTPs. Those values seed
   everything downstream, and PTP carry-over means an error there propagates for years.
2. Answer the eight open questions in `rules-engine-spec.md` and author the Divot Diggers ruleset
   as config. Two weeks, no code, highest ROI work in the whole project.
3. Stand up the monorepo and get `packages/scoring-engine` reproducing 2025 from a JSON fixture,
   driven by that config rather than by constants in the code.
