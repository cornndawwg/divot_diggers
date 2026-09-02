#!/usr/bin/env bash
#
# Prepares the local development database so `pnpm dev:api` just works:
#   - applies the migrations to the database named in DATABASE_URL
#   - creates a NON-OWNING role for domain queries and writes APP_DATABASE_URL into .env
#
# Safe to re-run. It never drops the database, so your data survives.
#
#   pnpm db:setup-dev
#
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "FAIL: no .env file. Copy .env.example first." >&2; exit 1; }
set -a; . ./.env; set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "FAIL: DATABASE_URL is not set in .env" >&2; exit 1; }

DB_NAME="${DATABASE_URL##*/}"
BASE="${DATABASE_URL%/*}"
MAINT="${BASE}/postgres"
ROLE="ddga_app"

echo "Development database: ${DB_NAME}"

if ! psql "$MAINT" -qtAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo "  creating it"
  psql "$MAINT" -qtAc "CREATE DATABASE ${DB_NAME}" >/dev/null || exit 1
fi

echo "Applying migrations"
pnpm db:migrate 2>&1 | sed 's/^/  /' || exit 1

# A non-owning role, because a table owner bypasses its own RLS policies.
if psql "$MAINT" -qtAc "SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'" | grep -q 1; then
  echo "Role ${ROLE} already exists; rotating its password"
  APP_PASSWORD=$(openssl rand -hex 16)
  psql "$MAINT" -qtAc "ALTER ROLE ${ROLE} WITH PASSWORD '${APP_PASSWORD}'" >/dev/null || exit 1
else
  echo "Creating non-owning role ${ROLE}"
  APP_PASSWORD=$(openssl rand -hex 16)
  psql "$MAINT" -qtAc "CREATE ROLE ${ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS" >/dev/null || exit 1
fi

echo "Granting it the privileges the API needs (no DELETE, deliberately)"
psql "$DATABASE_URL" -qtAc "GRANT USAGE ON SCHEMA public TO ${ROLE}" >/dev/null || exit 1
psql "$DATABASE_URL" -qtAc "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${ROLE}" >/dev/null || exit 1
psql "$DATABASE_URL" -qtAc "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}" >/dev/null || exit 1

# Rewrite APP_DATABASE_URL in .env, in place, without disturbing anything else.
APP_URL="${BASE/\/\/*@//\/${ROLE}:${APP_PASSWORD}@}"
APP_URL=$(python3 - "$DATABASE_URL" "$ROLE" "$APP_PASSWORD" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url, role, password = sys.argv[1], sys.argv[2], sys.argv[3]
parts = urlsplit(url)
netloc = f"{role}:{password}@{parts.hostname}"
if parts.port:
    netloc += f":{parts.port}"
print(urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment)))
PY
)

python3 - "$APP_URL" <<'PY'
import pathlib, sys
app_url = sys.argv[1]
path = pathlib.Path('.env')
lines = path.read_text().rstrip('\n').split('\n')
out, replaced = [], False
for line in lines:
    if line.startswith('APP_DATABASE_URL='):
        out.append(f'APP_DATABASE_URL={app_url}')
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append('')
    out.append('# Non-owning role for domain queries, written by scripts/setup-dev-db.sh.')
    out.append('# A table owner bypasses its own RLS policies, so the API must not be the owner.')
    out.append(f'APP_DATABASE_URL={app_url}')
path.write_text('\n'.join(out) + '\n')
PY
chmod 600 .env

echo
echo "Verifying the role really is unprivileged"
psql "$APP_URL" -qtAc "SELECT 'current_user=' || current_user || ' superuser=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user" | sed 's/^/  /'
tables=$(psql "$DATABASE_URL" -qtAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
echo "  tables in ${DB_NAME}: ${tables}"

echo
echo "Ready. Start the two servers in separate terminals:"
echo "  pnpm dev:api"
echo "  pnpm dev:web"
