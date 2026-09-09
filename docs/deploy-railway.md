# Deploying to Railway

Two services in one Railway project, both deploying from this repository. A monorepo is fine
— each service builds the whole workspace and starts a different part of it.

```
        browser
           │  https://<your-domain>
           ▼
  ┌──────────────────┐        http://api.railway.internal:8787
  │  web  (public)   │ ───────────────────────────────────────▶ ┌──────────────────┐
  │  Next.js console │                                          │  api  (private)  │
  └──────────────────┘                                          │  Hono            │
                                                                └─────────┬────────┘
                                                                          │
                                                                  ┌───────▼────────┐
                                                                  │   Postgres     │
                                                                  └────────────────┘
```

The console proxies `/api/*` through to the API server-side, so there is one public origin,
no CORS, and first-party session cookies. The API has **no public domain** — nothing outside
the project can reach it.

## The database looks after itself

`pnpm release` runs on every deploy of the API service and does two things: applies pending
migrations, then makes sure the non-owning role exists with the right grants. Railway's
Postgres has no public endpoint by default, and it does not need one — this all happens from
inside the project.

Both steps are idempotent, so a redeploy is safe, and a migration that adds a table gets that
table granted on the same deploy.

The role and password come from `APP_DATABASE_URL` itself, so the string the API connects with
and the role that gets created cannot drift apart. Generate the password once:

```bash
openssl rand -hex 32
```

and set `APP_DATABASE_URL` to `DATABASE_URL` with the user and password swapped for
`ddga_app` and that value.

### Why this matters more than it looks

**A Postgres table owner bypasses its own row level security.** An API connecting as the owner
has every tenancy policy in the schema switched off — one group can read another's data, and
nothing in the logs, the tests or the console says a word.

Setting `APP_DATABASE_URL` to the same value as `DATABASE_URL` therefore looks like it
satisfies the requirement and in fact defeats it entirely. Two things now stop that:

- `db:provision-role` refuses to run when `APP_DATABASE_URL` names the owning role, rather
  than stripping the database's own superuser of its privileges.
- The API asks Postgres, as the role that will actually run the queries, whether it is a
  superuser, holds `BYPASSRLS`, or owns any tables. In production any of those refuses the
  boot, naming which one.

## Service 1 — `web`

| Setting | Value |
|---|---|
| Source | this repository, branch `main` |
| Root directory | `/` |
| Build command | `pnpm build:web` |
| Start command | `pnpm start:web` |
| Public networking | generate a domain — this is the one people use |

Variables:

| Name | Value |
|---|---|
| `API_INTERNAL_URL` | `http://api.railway.internal:8787` — match the API service's name |
| `PUBLIC_URL` | the public domain, e.g. `https://divotdiggers.up.railway.app` |
| `NODE_ENV` | `production` |

## Service 2 — `api`

| Setting | Value |
|---|---|
| Source | the same repository and branch |
| Root directory | `/` |
| Build command | `pnpm typecheck` |
| Start command | `pnpm release && pnpm start:api` |
| Public networking | **none.** Do not generate a domain. |

`pnpm release` applies any pending migrations before the server comes up. Only this service
does that — two services racing the same migration is how a half-applied schema happens.

Variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — the owning role, used for migrations and auth |
| `APP_DATABASE_URL` | the same, as `ddga_app` — every domain query runs through this |
| `AUTH_SECRET` | `openssl rand -hex 32` |
| `PUBLIC_URL` | the **web** service's public domain. Emailed links are built on it. |
| `WEB_URL` | the same public domain |
| `MAILGUN_API` | your Mailgun private API key |
| `MAILGUN_DOMAIN` | your Mailgun sending domain |
| `MAIL_FROM` | optional, defaults to `Divot Diggers <noreply@$MAILGUN_DOMAIN>` |
| `PORT` | `8787`, so `API_INTERNAL_URL` above has a fixed port to name |
| `NODE_ENV` | `production` |

`PUBLIC_URL` starting with `https://` is what puts session cookies in secure mode, and
`WEB_URL` is the only origin Better Auth will trust. Both must be the real public domain, not
the API's internal address.

## Seeding a fresh deployment

Against the Railway database, in this order:

```bash
pnpm rulesets:seed divot-diggers
pnpm courses:seed  divot-diggers
pnpm history:seed  divot-diggers 2025
pnpm history:seed  divot-diggers 2026
pnpm gate2         divot-diggers      # expect: GATE 2 PASSED
```

Creating the group and its first owner happens by signing up in the browser.

## Checking it worked

1. The web service's domain loads the sign-in page.
2. Sign up. The verification email arrives and its link resolves on the public domain — this
   is the step that could not be tested locally.
3. `pnpm gate2 divot-diggers` against the Railway database reports PASSED.
4. The API service has no public domain, and requests to `<web-domain>/api/events` while
   signed out return 401 rather than data.

## Things that will bite

- **Railway's private network is IPv6-only.** The API binds `::` for this reason. Anything
  binding `0.0.0.0` is unreachable at `*.railway.internal`, and the symptom is every proxied
  request failing to connect while the service itself looks healthy.
- **Railpack, not Nixpacks.** The build and start commands above are all it needs; the
  `railpack.web.json` and `railpack.api.json` files in the repo hold the same thing for
  services configured to read config from the repo.
- **Do not point both services at the same start command.** Two copies of the console with
  no API is a confusing failure.
- **`pnpm gate2` is the honest check** that a deployment's data is right. Run it after any
  seeding.
