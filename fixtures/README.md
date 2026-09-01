# Golden Fixtures — Dogfight Scoring Engine

Extracted from `DDD_Calibration2026.xlsx`. These are the acceptance tests for
`packages/scoring-engine`. The engine must reproduce every `expected` value in these files
while driven entirely by `../divot-diggers-ruleset.json` — no Divot Diggers constants in code.

## What's here

| File | Contents |
|---|---|
| `dogfight-{2019,2021,2023,2025}.json` | Full 3-round years. 63 players total. |
| `dogfight-2026.json` | Round 1 only — see caveat below. |
| `ptp-carryover.json` | 41 year-over-year PTP transitions. |
| `starting-ptp-{2018,2022,2024}.json` | Carried-forward PTPs from template tabs. |
| `manifest.json` | Index + engine parameters. |

## Verification status

All five golden years reproduce the spreadsheet's derived columns exactly (0 mismatches),
allowing for the sheet's display rounding — deltas render at 0 decimals, targets at 1.

Carry-over chain, where each played year feeds the next tab's starting PTP:

| Transition | Result |
|---|---|
| 2019 → 2021 | 6 / 6 |
| 2021 → 2022 | 2 / 8 — see below |
| 2023 → 2024 | 15 / 15 |
| 2025 → 2026 | 12 / 12 |

**35 of 41 transitions reproduce mechanically.**

## Three things the data revealed

**1. Only five tabs contain played rounds.** 2018, 2022, and 2024 hold starting PTPs with all
scores at zero. They aren't empty templates — they're landing pads. 2023's computed carry values
match the 2024 tab's starting PTPs 15 for 15, so the trip happened and the scores were recorded
somewhere other than this workbook. Treat these as PTP snapshots, not as playable years.

**2. The 2021 → 2022 transition is manually adjusted.** Six of eight players start 1–2 points
higher than the formula produces (Levi 24 → 26, Kenny 12 → 13, Jack 17 → 18). Every adjustment
is upward and small, consistent with a planner nudging for handicap movement. This is direct
evidence that **planner override on carried PTP is a required feature, not a nice-to-have** —
it already happens. The engine should compute the suggestion; a human confirms it.

**3. The 2026 tab's Round 2 and 3 columns hold 2025 values.** They match the 2025 tab
position-for-position, so the tab was copied forward and those columns were never overwritten.
Round 1 matches the whiteboard for all 24 players and is included; R2 and R3 are excluded.
Enter the real numbers before they seed 2027.

## Floating point

Every value in the recurrence is a dyadic rational — inputs are integers and the only operation
is repeated halving. These are exactly representable in IEEE 754, so `number` is safe and no
decimal library is needed. Do not round intermediate values.

## Rounding

`carryoverRounded` uses **half away from zero** (33.5 → 34), not banker's rounding. JavaScript's
`Math.round` is correct here; Python's `round()` and .NET's default are not. `ptp-carryover.json`
contains cases that distinguish them — 32.5 → 33, 34.5 → 35, 37.5 → 38.

## Name normalization

The 2018 and 2019 tabs suffix names with a handicap (`Kenny Adkins-30`). Fixtures store the
clean name. Player identity across years is by normalized name here; the real system should use
a stable `person_id`.
