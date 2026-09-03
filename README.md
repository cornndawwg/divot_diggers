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

---

## Running it locally

Everything below assumes `.env` exists (copy `.env.example`). `.env` is gitignored and holds
real credentials — never commit it.

**One-time setup.** Postgres 16 runs in Docker as its own container, separate from anything
else on the machine:

```
docker start ddga-postgres          # see .env.example for the create command
pnpm db:setup-dev                   # migrate, then create the non-owning role the API uses
```

`db:setup-dev` is safe to re-run and never drops the database. It writes `APP_DATABASE_URL`
into `.env` for you.

**The two servers**, in separate terminals:

```
pnpm dev:api                        # API + auth on http://localhost:8787
pnpm dev:web                        # planner console on http://localhost:3000
```

Leave both running and open http://localhost:3000. If either reports
`EADDRINUSE`, a copy is already running — the error message tells you how to find and stop it.
On a remote machine, forward ports 3000 and 8787 (VS Code does this from its Ports panel).

**One origin.** The browser only ever talks to port 3000. Next proxies `/api/*` through to the
API server side, so there is one port to forward, session cookies are first-party, there is no
CORS, and an emailed verification link resolves from any device that can reach the console.
`PUBLIC_URL` is what links are built on and defaults to `WEB_URL`; `API_INTERNAL_URL` is where
the proxy forwards to and defaults to `http://localhost:8787`.

**Getting a link without email.** Useful when mail is slow or the address is not real:

```
pnpm auth:link verify you@example.com
pnpm auth:link reset  you@example.com
```

Both print a real link produced by the same code path the email uses, and send nothing.

**Checks you can run**, in rough order of how much they prove:

| Command | What it proves |
|---|---|
| `pnpm test` | The whole suite, including the 87 golden dogfight cases |
| `pnpm typecheck` | Every package compiles under strict TypeScript |
| `pnpm db:verify-schema` | `docs/schema.sql`'s own guarantees still hold |
| `pnpm db:verify-migration` | The baseline migrations still reproduce `docs/schema.sql` exactly |

**A note on the API and RLS.** Set `APP_DATABASE_URL` to a **non-owning** Postgres role. A table
owner bypasses its own row level security, which would make every policy decorative. The API
warns loudly on startup if that variable is missing.
