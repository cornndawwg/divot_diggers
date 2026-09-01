# Rules Engine & Course Model — Technical Spec

Companion to `build-plan.md`. This document covers the two subsystems that
determine whether the app can be resold: **configurable scoring rules** and **faithful course /
scorecard modeling**.

---

## Part 1 — Configurable scoring

### 1.1 The governing principle: parameterized strategies, not a rule DSL

There are two ways to build configurable scoring, and one of them is a tar pit.

**The tar pit:** a formula language. Store `"(pulled - ptp) + prior"` as a string, ship an
expression interpreter, let planners write arbitrary math. This looks maximally flexible and
fails badly — you inherit a programming language you have to document, sandbox, version,
error-report, and debug on behalf of non-programmers. When a group's leaderboard is wrong at
7 AM on a Saturday, you are debugging a stranger's arithmetic over text message.

**The right approach:** a **registry of strategy implementations, each with a typed config
schema.** The config parameterizes behavior; it never invents behavior.

```ts
type CompetitionStrategy<TConfig> = {
  key: string;
  configSchema: ZodSchema<TConfig>;
  computeStandings(rounds: RoundData[], config: TConfig): Standings;
};

registry.register(individualTargetStrategy);   // Divot Diggers dogfight, quota games
registry.register(stablefordStrategy);
registry.register(netStrokePlayStrategy);
registry.register(teamMatchPlayStrategy);      // Ryder Cup family
registry.register(skinsStrategy);
```

What this buys you:

- Every ruleset is **validatable before an event starts**. Bad config is caught at authoring
  time, not on the 4th tee.
- A new format is a new strategy — typically a day or two of work — not a rewrite. And each one
  is a feature you can sell.
- The strategy list *is* your product's marketing copy. "Supports: Dogfight/Quota, Stableford,
  Modified Stableford, Net Stroke Play, Ryder Cup, Skins, Wolf, Nassau."

Ship v1 with two strategies: `individual_target` (your dogfight) and `team_match_play` (the
Cup). Add `stableford` and `net_stroke_play` before the second customer, because those two cover
the overwhelming majority of golf groups.

### 1.2 Layer 1 — Hole scoring profiles

A ruleset defines one or more named profiles. Competitions reference them by ID, so a single
event can score the morning round on points and the afternoon round on net strokes.

```jsonc
{
  "id": "ddd-points",
  "name": "Divot Diggers Points",
  "basis": "gross",                    // "gross" | "net"
  "table": [                           // fully CRUD — rows added/edited/removed by planner
    { "relativeToPar": -3, "label": "Albatross", "points": 16 },
    { "relativeToPar": -2, "label": "Eagle",     "points": 8  },
    { "relativeToPar": -1, "label": "Birdie",    "points": 5  },
    { "relativeToPar":  0, "label": "Par",       "points": 3  },
    { "relativeToPar":  1, "label": "Bogey",     "points": 2  },
    { "relativeToPar":  2, "label": "Double",    "points": 1  }
  ],
  "betterThanTable": { "mode": "clamp" },                // condor clamps to 16
  "worseThanTable":  { "mode": "value", "points": 0 },   // triple bogey or worse

  "specialRules": [                              // evaluated AFTER the table, in order
    { "id": "hole_in_one", "enabled": false, "trigger": { "strokes": 1 },
      "effect": { "mode": "override", "points": 20 } }
  ],

  "pickup": {
    "policy": "cap_at_first_zero",     // "cap_at_first_zero" | "cap_at_fixed" | "play_out"
    "fixedRelativeToPar": null,        // used only when policy = "cap_at_fixed"
    "recordCappedStrokes": true        // write in the capped score, don't leave it blank
  },

  "handicapAllocation": {                        // only used when basis = "net"
    "source": "handicap_index",        // "handicap_index" | "course_handicap"
    "allowance": 1.0,
    "method": "stroke_index"
  }
}
```

**The table is CRUD, not a fixed set of fields.** A planner adds, edits, reorders, and deletes
rows. The engine reads whatever rows exist and applies `betterThanTable` / `worseThanTable` at
the boundaries. Nothing about "birdie = 5" is known to the code — a group scoring Stableford
(par 2, birdie 3) authors a different table and the same engine runs it.

Resolved behaviors for the Divot Diggers ruleset:

- **Triple bogey or worse = 0.** Config, not constant.
- **16 points is the ceiling and belongs to the albatross (−3) alone.** A condor (−4) clamps to 16.

### 1.2a Special rules: the override layer

The base table is purely relative-to-par, which means it cannot see a hole-in-one — an ace on a
par 3 is just −2. A `specialRules` list sits **above** the table for exactly this: rules that key
off something other than the score-to-par relationship.

```jsonc
{ "id": "hole_in_one", "enabled": true, "trigger": { "strokes": 1 },
  "effect": { "mode": "override", "points": 20 } }
```

- Evaluated after the table produces a base value, in array order, so ordering is deterministic.
- `mode: "override"` replaces the base points outright; `mode: "add"` stacks a bonus on top.
  Your toggle is `enabled` — off by default, since an ace currently just scores as an eagle.
- Keep this list open-ended. It's where every group's house rule eventually lands: sandy par
  bonuses, birdie streaks, closest-to-pin points, a penalty for a three-putt. Each is a trigger
  plus an effect, and none of them requires touching the base table.

### 1.2b Pickup policy

Your crew picks up at triple bogey and writes the triple in. That is not "no score" — there is a
real number on the card, it just happens to be capped. Modeled as:

- **`cap_at_first_zero` (default).** The engine finds the first score-to-par value that earns zero
  points from the table and caps strokes there. With your table bottoming out at double bogey
  (+2, 1 point), the cap lands on par+3. **Derive it from the table rather than hardcoding "+3"**
  — a group whose table pays down to triple bogey automatically gets a cap of par+4, with no
  separate setting to keep in sync.
- **`play_out`** is the override for groups that finish every hole and record true scores.
- **`cap_at_fixed`** covers anyone who wants a cap unrelated to their points table.

Two consequences worth knowing:

- With a cap on, **gross totals are artificial**. Flag capped rounds in the archive and never post
  them to a handicap service. The dogfight doesn't care; a future net-scoring competition would.
- **Set this per competition, not globally.** Confirmed: the Cup uses true match-play
  concessions, not the dogfight pickup. See §1.3b — it doesn't reference a points profile at all.

### 1.3 Layer 2 — Competition config

This is where your PTP system lives, generalized. `individual_target` covers the Divot Diggers
dogfight, standard quota games, and Peoria-style systems.

```jsonc
{
  "id": "dogfight",
  "name": "Dogfight",
  "type": "individual_target",
  "scoringProfile": "ddd-points",
  "rounds": ["thu-am", "fri-am", "sat-am"],

  "target": {
    "initialValue": {
      "method": "constant_minus_handicap",   // | "fixed" | "manual"
      "constant": 54,
      "handicapSource": "handicap_index",    // NOT course handicap — see §1.3a
      "rounding": "half_up"
    },
    "carryover": "across_events",
    "carryoverRounding": "half_up",          // year-end value rounds to whole number
    "adjustmentFactor": 0.5,                 // fraction of delta folded back in
    "adjustBetweenRounds": true,
    "adjustAtEventEnd": true,
    "runningTotal": "cumulative",
    "precision": "full",                     // in-trip values stay fractional
    "displayPrecision": 1,
    "prorateByHoles": true,
    "didNotPlay": { "ptp": "freeze", "standing": "disqualify" },
    "lapsedPlayer": {                        // returning after missing one or more events
      "method": "carry_with_handicap_delta",
      "requirePlannerConfirmation": true
    }
  },

  "eligibility": { "minimumRoundsCompleted": 3 },

  "standings": { "sortBy": "running_total", "direction": "desc" },
  "tiebreak": {
    "chain": [],
    "fallback": { "mode": "planner_resolved", "label": "Putting contest" }
  },
  "payouts": [{ "place": 1, "amount": 380 },
              { "place": 2, "amount": 260 },
              { "place": 3, "amount": 80 }]
}
```

The engine's recurrence, driven entirely by that config:

```
P₁ = initialValue (or carried-over rating)
Rₙ = pulledₙ − Pₙ + (runningTotal === "cumulative" ? Rₙ₋₁ : 0)
Pₙ₊₁ = Pₙ + adjustmentFactor × (Rₙ − Rₙ₋₁)
```

Set `adjustmentFactor: 0` and `carryover: "none"` and you have a plain quota game. Set
`runningTotal: "per_round"` and each day stands alone. Your system falls out of the same code as
a special case, which is the test that the abstraction is honest.

Set `adjustmentFactor: 0` and `carryover: "none"` and you have a plain quota game. Set
`runningTotal: "per_round"` and each day stands alone. Your system falls out of the same code as
a special case, which is the test that the abstraction is honest.

Resolved behaviors, with the reasoning that matters:

**`precision: "full"` + `carryoverRounding: "half_up"`.** This was the question you weren't sure
about, and your spreadsheet answers it. In-trip targets are fractional — Kenny Adkins finished
2025 at exactly 14.375 — but the value that carries into the next year is a whole number, and he
started 2026 at 14. I rebuilt all twelve 2025 returnees at full precision and compared to their
2026 starting values: **12 of 12 match, and only if you round half *up*.** Three players landed on
exact halves (32.5 → 33, 34.5 → 35, 37.5 → 38). This matters more than it sounds: many languages
default to banker's rounding, which rounds half to even and would have given 32, 34, and 38 —
wrong for two of the three. Specify `half_up` explicitly in the engine and test it, because the
default will silently be wrong for a quarter of your field.

**`didNotPlay` is two separate decisions, and they point opposite ways.** Missing a round freezes
the PTP — the rating is a long-lived asset and shouldn't be damaged by a player having to leave
early. But it also **disqualifies them from that year's standings**, because a two-round
cumulative can't fairly be ranked against three. Modeling these as one field would force you to
choose; modeling them as two gets your actual rule, which is "protect the rating, forfeit the
prize."

In the UI, a DQ'd player should still appear on the leaderboard, greyed and flagged, not silently
removed. People want to see where they would have finished.

**`lapsedPlayer: "carry_with_handicap_delta"`.** Your rule — carries from their last appearance,
adjusted slightly for handicap movement since. Because PTP is inversely related to handicap, the
natural suggestion is `newPTP = lastPTP − (currentHandicap − handicapAtLastAppearance)`: a golfer
who improved by 3 strokes gets +3 on their target. The app should *suggest* that number on a
reconciliation screen showing last PTP, the handicap delta, and the year gap — then let the
planner accept or override. This is a judgment call, not a formula, so the config makes it a
default with confirmation required rather than something that silently applies.

**Tiebreak as a two-stage system.** `chain` holds automatic tiebreakers evaluated in order
(last-round delta, best single round, lowest handicap, count-back on the final nine — a menu the
planner picks from and orders). When the chain is empty or exhausts, `fallback.planner_resolved`
marks the tie in the standings, prompts the planner, and records both the winner and the stated
reason in the archive. Your putting contest happens on the practice green; the app's job is to
detect the tie, name the method, and record the outcome — not to pretend it can adjudicate it.

### 1.3a Handicap index vs. course handicap — resolved: use the index

A **handicap index** is portable: it's a rating of ability, not tied to any course. Mike Sinkule's
6.4 is his index. A **course handicap** is what that index converts to at one specific course and
tee set, because a hard course from the back tees demands more strokes than an easy one from the
forward tees:

```
Course Handicap ≈ Index × (Slope ÷ 113)
```

Caledonia's card lists four tee sets with slopes from 144 (Pintail) down to 119 (Redhead). So
`54 − handicap` gives a different answer depending on which number you feed it:

| Player | Index | PTP from index | Pintail (144) | Wood Duck (128) | Redhead (119) |
|---|---|---|---|---|---|
| Mike Sinkule | 6.4 | **48** | 46 | 47 | 47 |
| Justin Crumpler | 11.5 | **43** | 39 | 41 | 42 |
| Lee Butler | 20.0 | **34** | 29 | 31 | 33 |
| Shay Shamburger | 38.0 | **16** | 6 | 11 | 14 |

The spread is small for low handicaps and enormous for high ones — Shay's starting target would
be 16 or 6 depending on the choice.

**Keep using the index. Three reasons:**

1. **It's what you already do.** `54 − 6.4 = 47.6 → 48`, and 48 is Mike's starting PTP in the
   2026 sheet. Every first-timer in the file was seeded from the index.
2. **Course handicap would break carry-over.** You play three different courses over the weekend
   with three different slopes. A course-handicap PTP would have to be recalculated every round,
   which is incompatible with a single target that persists across rounds and across years.
3. **The self-correction absorbs any error anyway.** PTP adjusts by half the delta after every
   round. A seeding that's two strokes off is gone within a round or two, and after year one the
   handicap stops mattering entirely.

The config field exists (`handicapSource`) because groups running per-round net competitions will
want course handicap. For your ruleset it's `handicap_index` and it's settled.

And the Cup:

```jsonc
{
  "id": "wrc",
  "name": "Winona Ryder Cup",
  "type": "team_match_play",
  "teams": [{ "id": "a", "name": "Inglorious Bogies" },
            { "id": "b", "name": "Bad Birdies" }],
  "rosterSelection": { "method": "captain_draft", "order": "snake" },
  "pointsPerMatch": { "win": 1, "halved": 0.5, "loss": 0 },
  "totalPointsAvailable": 24,
  "clinchThreshold": 13,
  "tiebreak": "captains_playoff",
  "handicapAllowance": 0.0,
  "sessions": [
    { "roundId": "thu-pm", "format": "scramble",       "playersPerSide": 2, "matches": 6 },
    { "roundId": "fri-pm", "format": "alternate_shot", "playersPerSide": 2, "matches": 6 },
    { "roundId": "sat-pm", "format": "singles",        "playersPerSide": 1, "matches": 12 }
  ],
  "matchupMethod": "captain_pick",
  "matchupLockTime": "night_before"
}
```

`totalPointsAvailable` and `clinchThreshold` should be **derived and validated**, not just
trusted: 6 + 6 + 12 = 24, and 13 > 24/2. If a planner configures sessions that don't sum to the
declared total, refuse to start the event.

**`handicapAllowance: 0.0`** — resolved. Handicap's only role in your event is seeding PTP for
first-timers and adjusting lapsed returnees; the Cup is played gross, with captains balancing
matchups by judgment rather than the app allocating strokes.

Worth a sanity check before you lock it, though: your field spans a 6.4 to a 38, and scratch
alternate shot across that range can produce lopsided matches. It stays configurable regardless —
most groups you eventually sell to will want the USGA allowances (90% four-ball, 50% foursomes,
100% singles), so the field needs to exist and be per-session even though yours is zero.

### 1.3b Match play is a different scoring model, not a variant of the same one

Worth stating plainly, because it changes the UI as well as the engine: **the Cup rounds don't use
a points table at all.** `team_match_play` compares gross strokes hole by hole and awards the
hole; there is nothing to convert to points. That's why the WRC competition in the ruleset has no
`scoringProfile` reference — not an omission.

```jsonc
"matchPlay": {
  "concessions": {
    "hole":   { "byOpponent": true, "bySelf": true },
    "stroke": { "byOpponent": true },
    "recordStrokes": false
  },
  "closeOutWhenDecided": true,
  "statusFormat": "holes_up_thru"
}
```

- **Concessions run both directions.** An opponent can give you the hole, and a player can concede
  their own hole and pick up. Both end the hole immediately with no stroke count recorded — a
  conceded hole is genuinely unscored, not scored as a zero.
- **`closeOutWhenDecided`** ends the match when one side leads by more holes than remain. This is
  why match results read "4&3" and why a 9-hole match can finish on the 6th green. The engine has
  to detect it; the app has to stop asking for scores.
- **`statusFormat: "holes_up_thru"`** is the live display — "3 UP thru 14" — which is what the
  captains' leaderboard shows rather than a running score.

The practical consequence: **Cup rounds need a match card, not a stroke card.** Two columns, a
running hole-by-hole status, concede buttons, and an automatic close-out. Budget it as a separate
screen from the dogfight scorecard in Phase 4, not a mode toggle on the same component.

### 1.4 Versioning and immutability

Non-negotiable, and the thing most likely to be skipped and regretted:

- Rulesets are **append-only versions**. Editing creates v(n+1); v(n) is never mutated.
- **On event start, snapshot the fully-resolved ruleset onto the event** as JSONB. Running and
  completed events read the snapshot, never the live ruleset.
- Without this you cannot recompute 2027's standings in 2029 after someone tweaks a point value,
  and your entire historical archive silently becomes fiction.
- Store the engine version alongside the snapshot too. A bug fix in the engine changes results;
  you want to know which code produced which archive.

### 1.5 Preset library

Ship system-owned rulesets (`org_id = null`) that any org can clone and edit. This is most of
your onboarding story for the resale product — a new group picks "Stableford" and is playing in
five minutes instead of authoring config.

Seed with: Divot Diggers Dogfight (yours, generalized), Standard Stableford, Modified Stableford,
Net Stroke Play, Ryder Cup (24 pt), Ryder Cup (28 pt), Skins.

### 1.6 What planners actually see

Never show JSON. The console renders a form per strategy type, driven by the same Zod schema
that validates the config. The JSON is the storage format and the API contract, not the UI.

Include a **rules preview**: enter a hypothetical scorecard, see the computed points and target
adjustment live. Planners will not trust a config they can't test, and they shouldn't.

---

## Part 2 — Course and scorecard fidelity

Your requirement: the scorecard must match the actual course, at 9 or 18 holes. This is more
structural than it sounds, because par and stroke index vary by **tee set**, not just by course.

### 2.1 Model

```
courses          (id, org_id NULL /* NULL = shared library */, name, address, geo,
                  total_holes, verified, source)
tee_sets         (course_id, name, gender, course_rating, slope_rating, par_total, yardage_total)
course_holes     (tee_set_id, hole_number, par, yardage, stroke_index)
nines            (course_id, name, hole_numbers[])   -- for 27/36-hole facilities
```

Caledonia from your packet is the worked example: one course, four tee sets — Pintail
(71.4 / 144), Mallard (69.3 / 140), Wood Duck (67.4 / 128), Redhead (63.6 / 119) — each with its
own yardages, sharing pars, with a men's and a ladies' stroke index row. Par 35 out, 35 in, 70
total. The model has to hold all of that or the net-scoring strategies can't work.

### 2.2 Rounds select holes explicitly

```jsonc
"round": {
  "id": "thu-pm",
  "courseId": "...",
  "teeSetId": "...",
  "holeSelection": { "mode": "front9" }   // "all" | "front9" | "back9" | "nine:<id>" | "custom"
}
```

`resolveHoles(teeSet, holeSelection)` returns the ordered hole list. Rules that follow from it:

- **The scorecard UI renders exactly those holes** — real pars, real yardages, real stroke
  indexes, correct Out/In/Total subtotals. Never a generic 18-box grid.
- Submitting a scorecard whose hole count doesn't match the resolved list is **rejected**, not
  coerced.
- Par totals for the round come from the selection, so a 9-hole par 35 scores correctly against
  a points table built on relative-to-par.
- `prorateByHoles` (§1.3) reads `holesInPlay` from here.

Your event needs this immediately: the packet prices the Thursday/Friday/Saturday afternoon Cup
rounds as 9-hole estimates while the morning dogfight rounds are full 18. Same day, same course
family, different hole counts, different competitions. That's the MVP case, not an edge case.

### 2.3 Getting course data in

There is no comprehensive, reliably-licensed public course API, so this needs a real answer
rather than an integration.

**The scale is smaller than it looks.** You need the tee set you're *actually playing*, not all of
them. For the 2027 trip that's four courses × one tee set — about twenty minutes of typing, once,
weeks before you leave. Do not build tooling to avoid twenty minutes of work.

**What's actually required, in priority order:**

1. **Par per hole — mandatory.** Every points calculation is relative to par. Nothing works
   without it.
2. **Stroke index — optional for you.** Only used for net scoring and handicap allowances. The
   Divot Diggers play gross in both competitions, so this can be blank in the MVP. Other groups
   will need it.
3. **Yardage — cosmetic.** Nice on the scorecard, affects nothing.

That ordering matters: a course is *usable* with eighteen numbers.

**Three sources, build in this order:**

**(a) Manual entry.** Always works, never breaks, ship it first. This is the 2027 answer.

**(b) Scorecard photo import.** Planner photographs the card; a vision model extracts par, stroke
index, and yardage rows; the planner confirms in a diff view. What makes this trustworthy is that
**scorecard data carries its own checksums** — see §2.3a.

**(c) Shared library.** Courses default to `org_id = null`. One group enters Caledonia's Pintail
tees and every future group gets it free. This compounds: after a few dozen groups it's the part
of the product a competitor can't clone quickly.

On third-party APIs — the coverage is patchy and, more importantly, terms of service typically
forbid redistribution, which is fatal to a shared library you intend to resell. Data you extract
from a card you photographed doesn't carry that restriction. Worth a lawyer's glance before you
commercialize either way, but photo import is the cleaner foundation.

### 2.3a Why photo import is safe: scorecards self-validate

A scorecard is a highly redundant document. Extracted data can be checked against itself, so most
OCR errors are caught automatically rather than discovered on the 4th tee.

| Check | Catches |
|---|---|
| Front/back pars sum to the printed OUT/IN/TOTAL | Any misread par |
| Stroke indexes are a permutation of 1–18 | Duplicated or dropped index |
| Front nine indexes all even, back nine all odd (common convention) | Row misalignment |
| Each tee's yardages sum to its printed OUT/IN/TOTAL | Any misread yardage |
| Yardage decreases monotonically from back tees to forward, hole by hole | Rows read out of order |
| Par between 3 and 6, slope between 55 and 155 | Gross extraction failure |

**This was tested on the real card.** All four Caledonia tee sets were extracted from the scan in
the 2026 packet and every check above passed — pars 35/35/70 against the printed totals, stroke
indexes a clean even/odd split, all four yardage rows summing exactly. Output is in
`../seed/caledonia.json`; the validator belongs in the import pipeline, not just in a one-off script.

Anything failing a check goes to the planner for review rather than saving silently. Anything
passing all of them is almost certainly correct.

**Two operational details worth building:**

- **Capture ahead of time, but allow on-site entry.** Courses get swapped for weather. The
  scorecard screen should offer "this par looks wrong" so a player can flag a mismatch against the
  physical card, which is free crowd-sourced correction.
- **Allow a per-round par override.** Temporary greens and renumbered holes are rare but real, and
  a wrong par silently corrupts every point calculation for that hole.

### 2.3b Two ways in: type it, or photograph it

MVP supports exactly two paths. Both are planner-facing, both work at a kitchen table weeks ahead
or in a parking lot ten minutes before a tee time.

**Path A — manual entry.** Pick the course name, add a tee set, tap pars. Par is the only
mandatory field; stroke index and yardage are optional and can be filled in later or never.
Eighteen taps, or nine for a replay. This always works and needs no connectivity.

**Path B — photograph the scorecard.** The planner shoots the card, a vision model extracts the
par, stroke index, and yardage rows, the checksum suite from §2.3a runs, and the planner approves
in a diff view. When every check passes the diff is usually a formality.

Path A is the floor that never fails. Path B is the one people will actually use.

**Not in MVP:** GPS course matching, the shared cross-tenant library, and licensed vendor feeds.
All three remain good ideas — see §2.3c — but none of them is needed to run your trip, and each
adds a dependency. Course records stay scoped to the org that created them for now, with the
`provenance` column already in place so a shared library can be switched on later without
migrating anything.

### 2.3b-i Scorecard images are ephemeral

Retaining photos is a recurring cost that grows forever and buys nothing once the numbers are
extracted. The image is an input, not an asset.

**Lifecycle:**

1. **Downscale on device before upload.** A phone photo is 3–5 MB; a scorecard is legible at
   ~1600px wide, around 300–500 KB. That is a 10x cost reduction before a byte leaves the phone,
   and it makes the upload survive a weak connection.
2. **Upload to object storage under a short-lived key.** Never a blob column in Postgres.
3. **Extract, validate, present the diff.** The planner needs to see the photo during review to
   compare against the extraction, so it has to survive that window — but only that window.
4. **Delete on approval or rejection.** The moment the import job reaches `applied` or `failed`,
   delete the object and null out `image_key`.
5. **Backstop with a storage lifecycle rule at 48 hours.** Jobs get abandoned — someone starts an
   import and drives to the first tee. A bucket-level expiry rule guarantees nothing lingers even
   if the application logic misses a case. Belt and braces, because orphaned objects are exactly
   the thing nobody notices until the invoice.
6. **Keep the extracted JSON forever.** It's a few kilobytes, it's the actual value, and it's what
   you'd need to audit a disputed par.

Net effect: storage cost is bounded by concurrent in-review imports, not by total imports ever
performed. At your scale that's effectively zero, and it stays effectively zero at a thousand
groups.

### 2.3c How the incumbents do it, and why we can't copy them

Worth knowing before committing to a plan: **none of the big consumer apps build their course
database themselves.** There is a small licensing industry behind almost all of them.

**The suppliers.** iGolf carries 40,000+ courses across 175+ countries and licenses tee box and
scorecard data to mobile apps and GPS devices; 55+ companies run on its Connect API. GolfLogix
licenses par, handicap allocation, and slope through a Map Server API on either subscription or
per-request terms. Golf Intelligence starts at $399/month for 10,000 credits, where a scorecard
costs 1 credit and full detail with GPS costs 3, and offers a free 50-credit trial. golfapi.io
covers 40,000+ courses and — unusually — offers a **full CSV export** alongside its REST API.
GolfCourseAPI is free to try with roughly 30,000 courses.

**How 18Birdies specifically behaves.** Its database is centralized and curated. Users cannot add
a course. If a course isn't found, the documented path is to email support so the team can review
whether it can be added; the same goes for correcting bad data.

**That is exactly the failure mode you described.** Standing in a parking lot at an unplanned
course, ten minutes to a tee time, an 18Birdies-style app leaves you emailing support. The tiered
fallback in §2.3b isn't a workaround for lacking a licence — it's the thing those apps don't have,
and it's the difference between playing and not playing.

**The licensing terms are actively hostile to the shared library.** This is the finding that
matters most for the resale plan. Golf Intelligence permits caching but forbids third-party
sharing and derivatives, and stores a downloaded course per individual user for a year — another
user wanting the same course spends the credits again. golfapi.io permits commercial use and
caching in your own product but prohibits reselling, redistributing, or sharing with third
parties. **A cross-tenant course library built from licensed data would breach both.**

**So: license for breadth, own the fallback, and keep the two pools physically separate.**

| Pool | Source | Can enter the shared library? |
|---|---|---|
| `provenance = 'licensed'` | Vendor API or export | **No.** Purge on termination. |
| `provenance = 'owned'` | Manual entry, photo import, par-only | Yes. |

The schema enforces this with a trigger rather than a convention — inserting a licensed row with
`org_id IS NULL` raises an exception. Convention is not sufficient protection for a contractual
obligation that survives five years past termination.

**Sequencing for your build:**

- **Now (private phase):** you need four courses. Enter them by hand, use the free tiers to
  experiment. Licensing is a resale problem, not a 2027 problem.
- **At resale:** license a provider so Tier 0 works from day one instead of waiting years for the
  library to fill. Of the options, golfapi.io's full CSV export suits this architecture best —
  a local table beats per-user API credits when the app is offline-first and every group at a
  resort hits the same handful of courses.
- **Always:** photo and par-only import stay, because they cover the courses no vendor has and
  they generate data you actually own.

### 2.4 Handicaps

- Store **handicap index** on the person and compute **course handicap** per round from the tee
  set's slope: `index × slope / 113` (plus the rating differential if you want full USGA
  fidelity). Don't store a single flat handicap number — it's wrong the moment someone plays a
  different tee.
- Allow manual override per event; plenty of groups use "committee handicaps" that ignore GHIN.
- GHIN API access is restricted and not worth pursuing for v1. Manual index entry with an
  optional CSV import covers it.

---

## Part 3 — Multi-tenancy checklist

Since resale is now a confirmed goal, these are load-bearing from the first commit:

- `organization_id` on **every** domain table. No exceptions, including course and ruleset tables
  where NULL means "shared/system."
- **Row Level Security policies on every table**, keyed to org membership — and a dedicated test
  suite that asserts org A cannot read org B's rows. Write these tests as adversarial cases, not
  happy paths. A missed RLS policy is the single most common way a Supabase app leaks customer
  data, and it fails silently.
- `people` identity is **global**; `org_members` grants access; `event_players` scopes to one
  event. A golfer in two groups is one person with two memberships and two independent PTP
  histories.
- Join codes and invite links scoped to org + event, expiring.
- Soft-delete and per-org export from day one. GDPR/CCPA obligations attach the moment you take
  a paying customer outside your friend group.
- Billing: don't build it. When a second group wants in, invoice them manually. Add Stripe when
  manual invoicing becomes annoying — that's a good problem and it'll be obvious.

---

## Part 4 — The social layer (post-MVP)

Deliberately out of the MVP, but two decisions to make now so it isn't a rewrite later:

**Architectural hooks:** the `people` + `org_members` model already gives you durable identity
and group membership across years, which is the whole foundation. Nothing else is needed today.

**Scope it down when you get there.** A general forum is a big build with a long tail of
moderation work. The version that actually serves your stated goal — staying in touch through
the year, planning impromptu rounds — is much smaller: a per-org feed, event chat threads, and a
lightweight "who's up for a round Saturday" post type with RSVPs. Build that, not phpBB.

**The compliance cost is real and worth knowing before you commit.** Once the app hosts
user-generated content, App Store Review Guideline 1.2 requires a published EULA, a content
filtering mechanism, in-app reporting of objectionable content, the ability to block abusive
users, and a commitment to act on reports within 24 hours. Google Play has parallel requirements.
That's a meaningful ongoing obligation for a side project, and it's the main reason to keep the
social layer out of your first store submission rather than merely out of the MVP.

---

## Rules status

**Resolved:**

| Question | Decision |
|---|---|
| Triple bogey or worse | 0 points — as a CRUD config value, never a constant |
| Ceiling / hole-in-one | 16 belongs to the albatross (−3) alone; better clamps to 16 |
| Pickup or concession | Pick up at triple, record the capped score, 0 points. `play_out` override available |
| Hole-in-one | Optional special rule that overrides the base table; off by default |
| Missed round | Freeze PTP **and** disqualify from that year's standings |
| WRC handicap strokes | None — gross match play; field stays configurable for other groups |
| PTP carry-over precision | Fractional in-trip, rounded **half up** at year end — 33.4 → 33, 33.5 → 34 (verified 12/12 against 2025 → 2026) |
| First-timer seeding | `54 − handicap **index**`, not course handicap |
| Lapsed player returning | Carry from last appearance, suggest a handicap-delta adjustment, planner confirms |
| Dogfight tiebreak | Planner-defined chain, falling back to a recorded off-app resolution |

| Hole-in-one value | 20 as the default, planner-editable; rule off by default |
| Cup hole scoring | True match-play concessions, either side may concede, no points table |
| Lapsed-player adjustment cap | Uncapped by default; planner confirms and may edit every suggestion |

**Nothing blocking remains.** Phase 0 is closed and the ruleset is authored in
`../divot-diggers-ruleset.json`.
