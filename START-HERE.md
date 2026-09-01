# Start Here

## 1. Put these files in an empty git repo

```
your-repo/
├── CLAUDE.md                  <- Claude Code reads this automatically
├── START-HERE.md              <- this file
├── README.md
├── BUILD-TASKS.md
├── divot-diggers-ruleset.json
├── docs/
│   ├── build-plan.md
│   ├── rules-engine-spec.md
│   ├── schema.sql
│   └── schema-tests.sql
├── fixtures/                  <- READ ONLY. Never let these be edited.
│   ├── README.md
│   ├── manifest.json
│   ├── dogfight-2019.json … dogfight-2026.json
│   ├── ptp-carryover.json
│   └── starting-ptp-2018.json / 2022 / 2024
└── seed/
    └── caledonia.json
```

`git init`, commit all of it, then open Claude Code in that folder. `CLAUDE.md` is picked up
automatically — you don't need to mention it.

## 2. Your first prompt

Paste this verbatim:

> Read CLAUDE.md, BUILD-TASKS.md, and docs/rules-engine-spec.md before doing anything.
>
> Then do task 1.1 only — the monorepo scaffold. Stop when it's done and tell me the command to
> verify it.
>
> Do not start task 1.2. Do not scaffold anything beyond what 1.1 describes.

The "task 1.1 only" and "do not start 1.2" are load-bearing. Without them Claude Code will build
several phases at once, and you'll lose the ability to check each step.

## 3. Every task after that

> Do task N.N. When it's done, tell me the verification command and what result to expect.

Run the command yourself. If it doesn't produce the stated result, say so and let Claude Code fix
it before moving on. Do not proceed past a failing gate.

## 4. The three moments to slow down

**Task 1.4** — all five golden years must reproduce, 87 cases, zero failures. This is the whole
project. Nothing built on a wrong engine is worth anything.

**Task 1.6** — a Stableford ruleset must run on **unmodified engine source**. This is the only
real proof the scoring rules aren't quietly hardcoded. If any engine file had to change, the
abstraction is broken and it's much cheaper to fix now than after four more phases.

**Gate 3** — play an actual round with four people. Not a simulation. Expect to find five things
in eighteen holes that no amount of planning surfaces.

## 5. If something feels wrong

Two phrases worth having ready:

> That contradicts invariant N in CLAUDE.md. Explain how your approach satisfies it.

> Don't change the fixture. The fixture is correct. Find the bug in the engine.

The second one matters. When a test fails, editing the expected value is the fastest way to make
it green and the fastest way to ruin the project.
