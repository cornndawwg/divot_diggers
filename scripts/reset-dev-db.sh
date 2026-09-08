#!/usr/bin/env bash
#
# Wipes the development database and rebuilds it from the migrations, then loads the
# course seed files. Nothing else survives: accounts, groups, events and rosters all go.
#
# DESTRUCTIVE. Only ever points at the database in .env, which is a local container.
#
#   pnpm db:reset-dev
#
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "FAIL: no .env file." >&2; exit 1; }
set -a; . ./.env; set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "FAIL: DATABASE_URL is not set." >&2; exit 1; }

DB_NAME="${DATABASE_URL##*/}"
BASE="${DATABASE_URL%/*}"
MAINT="${BASE}/postgres"

# Refuse anything that is not obviously a local development database.
if [[ "$BASE" != *"127.0.0.1"* && "$BASE" != *"localhost"* ]]; then
  echo "FAIL: ${BASE} is not local. This script only resets a local database." >&2
  exit 1
fi

echo "This will destroy everything in '${DB_NAME}' and rebuild it empty."
read -r -p "Type the database name to confirm: " CONFIRM
if [[ "$CONFIRM" != "$DB_NAME" ]]; then
  echo "Not confirmed. Nothing was changed."
  exit 1
fi

echo
echo "Dropping and recreating ${DB_NAME}"
psql "$MAINT" -qtAc "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)" >/dev/null || exit 1
psql "$MAINT" -qtAc "CREATE DATABASE ${DB_NAME}" >/dev/null || exit 1

echo "Applying migrations and recreating the app role"
bash scripts/setup-dev-db.sh | sed 's/^/  /' || exit 1

echo
echo "Done. The database is empty."
echo
echo "Next:"
echo "  1. pnpm dev:api and pnpm dev:web"
echo "  2. Sign up at http://localhost:3000/sign-up"
echo "  3. pnpm auth:link verify <your email>   (paste the link)"
echo "  4. Create your group on the Account page — it comes with a starter set of rules"
echo "  5. pnpm courses:seed <your-group-slug>     to load the Legends courses"
echo "  6. pnpm rulesets:seed <your-group-slug>    to use the Divot Diggers rules instead"
