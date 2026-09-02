#!/usr/bin/env bash
#
# Applies docs/schema.sql to a throwaway database and checks the guarantees in
# docs/schema-tests.sql. Safe to run repeatedly: the scratch database is dropped and
# recreated every time, so there are no "already exists" collisions.
#
#   ./scripts/verify-schema.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

SCRATCH_DB="ddga_schema_check"

if [[ ! -f .env ]]; then
  echo "FAIL: no .env file. Copy .env.example and set DATABASE_URL." >&2
  exit 1
fi
set -a; . ./.env; set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FAIL: DATABASE_URL is not set in .env" >&2
  exit 1
fi

# Same server, different database. Never touches the database in DATABASE_URL.
SCRATCH_URL="${DATABASE_URL%/*}/${SCRATCH_DB}"
# Admin work runs against the maintenance database so the scratch one can be dropped freely.
MAINT_URL="${DATABASE_URL%/*}/postgres"

fail=0
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf '  PASS  %-52s %s\n' "$1" "$3"
  else
    printf '  FAIL  %-52s got %s, expected %s\n' "$1" "$3" "$2"
    fail=1
  fi
}

echo "Rebuilding scratch database '${SCRATCH_DB}' ..."
psql "$MAINT_URL" -qtAc "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1 || exit 1
# schema-tests.sql does CREATE ROLE app_user, which errors if it already exists. Dropping the
# scratch database above removes the grants that would otherwise pin the role.
psql "$MAINT_URL" -qtAc "DROP ROLE IF EXISTS app_user" >/dev/null 2>&1 || {
  echo "FAIL: could not drop role app_user — something outside the scratch database still grants to it." >&2
  exit 1
}
psql "$MAINT_URL" -qtAc "CREATE DATABASE ${SCRATCH_DB}" >/dev/null 2>&1 || exit 1

echo
echo "=== docs/schema.sql ==="
schema_out=$(psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f docs/schema.sql 2>&1)
schema_rc=$?
schema_errors=$(printf '%s\n' "$schema_out" | grep -c 'ERROR:')
if [[ $schema_rc -ne 0 || $schema_errors -ne 0 ]]; then
  echo "$schema_out" | grep -E 'ERROR:|FATAL:' | head -20
fi
check "schema applies with no errors" "0" "$schema_errors"

tables=$(psql "$SCRATCH_URL" -qtAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
printf '  INFO  %-52s %s\n' "tables created" "$tables"

echo
echo "=== docs/schema-tests.sql ==="
tests_out=$(psql "$SCRATCH_URL" -q -f docs/schema-tests.sql 2>&1)

value_of() { printf '%s\n' "$tests_out" | grep -A2 "$1" | tail -1 | tr -d ' '; }

rls=$(printf '%s\n' "$tests_out" | awk '/rls_enabled_no_policy/{getline;getline;gsub(/ /,"");print;exit}')
check "tables with RLS on but no policy" "0" "$rls"

# The two ERRORs this file marks as the passing result.
immutable=$(printf '%s\n' "$tests_out" | grep -c 'is immutable; create a new version')
check "published ruleset rejects an update" "1" "$immutable"

one_team=$(printf '%s\n' "$tests_out" | grep -c 'cup_one_team_per_player')
check "player cannot be on two cup teams" "1" "$one_team"

total_errors=$(printf '%s\n' "$tests_out" | grep -c 'ERROR:')
check "no unexpected errors" "2" "$total_errors"

insider_events=$(printf '%s\n' "$tests_out" | awk '/insider \|/{c++; if(c==2){gsub(/[^0-9]/,"",$0); print; exit}}')
check "insider sees their own event" "1" "$insider_events"

outsider=$(printf '%s\n' "$tests_out" | grep 'OUTSIDER |' | tr -d ' ')
out_events=$(printf '%s\n' "$outsider" | sed -n '2p' | cut -d'|' -f2)
out_players=$(printf '%s\n' "$outsider" | sed -n '3p' | cut -d'|' -f2)
check "org B sees org A's events" "0" "$out_events"
check "org B sees org A's event_players" "0" "$out_players"

echo
if [[ $fail -eq 0 ]]; then
  echo "SCHEMA VERIFICATION PASSED"
else
  echo "SCHEMA VERIFICATION FAILED"
  echo
  echo "--- full schema-tests.sql output ---"
  printf '%s\n' "$tests_out"
fi
exit $fail
