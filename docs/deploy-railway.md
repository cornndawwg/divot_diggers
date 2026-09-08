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

## Before the first deploy: prepare the database

Run these from your machine, against the Railway database's **public** connection string
(Railway calls it the "Public Network" URL on the Postgres service's Connect tab). They only
need doing once.

```bash
DATABASE_URL='<railway public postgres url>' pnpm db:migrate:deploy

DATABASE_URL='<railway public postgres url>' \
APP_DATABASE_PASSWORD="$(openssl rand -hex 32)" \
  pnpm db:provision-role
```

The second one is not optional. **A Postgres table owner bypasses its own row level security**,
so an API connecting as the owner has every tenancy policy in the schema switched off — one
group could read another's data with nothing in the logs to say so. `db:provision-role`
creates `ddga_app` as `NOSUPERUSER NOBYPASSRLS`, grants it what it needs, and refuses to
report success if the role could still bypass RLS. The API declines to start in production
without it.

Keep the password you generated. `APP_DATABASE_URL` is the same connection string as
`DATABASE_URL` with the user and password swapped for `ddga_app` and that password.

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
