#!/usr/bin/env bash
#
# Proves packages/db/migrations/*.sql produces the same schema as docs/schema.sql.
#
# docs/schema.sql is the authority. The migrations are a split of it, so any
# difference here means the port drifted and must be corrected — in the migrations,
# never in docs/schema.sql.
#
#   ./scripts/verify-migration.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

REF_DB="ddga_ref"
MIG_DB="ddga_migrated"

[[ -f .env ]] || { echo "FAIL: no .env file." >&2; exit 1; }
set -a; . ./.env; set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "FAIL: DATABASE_URL is not set." >&2; exit 1; }

BASE="${DATABASE_URL%/*}"
MAINT="${BASE}/postgres"

rebuild() {
  psql "$MAINT" -qtAc "DROP DATABASE IF EXISTS $1 WITH (FORCE)" >/dev/null 2>&1
  psql "$MAINT" -qtAc "CREATE DATABASE $1" >/dev/null 2>&1
}

# pg_dump 16.14 emits a random \restrict nonce per run; strip it along with
# comments, SET lines and blank lines so only real schema remains.
normalise() {
  pg_dump --schema-only --no-owner --no-privileges --no-comments "$1" \
    | grep -vE '^(--|SET |SELECT pg_catalog|\\connect|\\restrict|\\unrestrict|$)' \
    | sed -E 's/[[:space:]]+$//'
}

fail=0

echo "Building reference database from docs/schema.sql ..."
rebuild "$REF_DB"
ref_out=$(psql "${BASE}/${REF_DB}" -q -v ON_ERROR_STOP=1 -f docs/schema.sql 2>&1)
ref_errors=$(printf '%s\n' "$ref_out" | grep -c 'ERROR:')

echo "Building migrated database from packages/db/migrations ..."
rebuild "$MIG_DB"
mig_errors=0
shopt -s nullglob
migrations=(packages/db/migrations/*.sql)
[[ ${#migrations[@]} -gt 0 ]] || { echo "FAIL: no migrations found." >&2; exit 1; }
for f in "${migrations[@]}"; do
  out=$(psql "${BASE}/${MIG_DB}" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  errs=$(printf '%s\n' "$out" | grep -c 'ERROR:')
  mig_errors=$(( mig_errors + errs ))
  if [[ $errs -ne 0 ]]; then
    echo "  in $f:"; printf '%s\n' "$out" | grep 'ERROR:' | head -5
  fi
done

check() {
  if [[ "$2" == "$3" ]]; then printf '  PASS  %-46s %s\n' "$1" "$3"
  else printf '  FAIL  %-46s got %s, expected %s\n' "$1" "$3" "$2"; fail=1; fi
}

echo
echo "=== results ==="
check "migrations apply with no errors" "0" "$mig_errors"
check "reference schema applies with no errors" "0" "$ref_errors"
check "migration files applied" "${#migrations[@]}" "${#migrations[@]}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
normalise "${BASE}/${REF_DB}" > "$tmp/ref.sql"
normalise "${BASE}/${MIG_DB}" > "$tmp/mig.sql"

for label in tables indexes policies triggers functions; do
  case $label in
    tables)    q="SELECT count(*) FROM pg_tables WHERE schemaname='public'" ;;
    indexes)   q="SELECT count(*) FROM pg_indexes WHERE schemaname='public'" ;;
    policies)  q="SELECT count(*) FROM pg_policies WHERE schemaname='public'" ;;
    triggers)  q="SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal" ;;
    functions) q="SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'" ;;
  esac
  a=$(psql "${BASE}/${REF_DB}" -qtAc "$q")
  b=$(psql "${BASE}/${MIG_DB}" -qtAc "$q")
  check "$label match" "$a" "$b"
done

if diff -q "$tmp/ref.sql" "$tmp/mig.sql" >/dev/null; then
  printf '  PASS  %-46s %s lines\n' "full schema dump is identical" "$(wc -l < "$tmp/ref.sql")"
else
  printf '  FAIL  %-46s\n' "full schema dump is identical"
  fail=1
  echo
  echo "--- differences (reference vs migrated) ---"
  diff -u "$tmp/ref.sql" "$tmp/mig.sql" | head -60
fi

echo
[[ $fail -eq 0 ]] && echo "MIGRATION VERIFICATION PASSED" || echo "MIGRATION VERIFICATION FAILED"
exit $fail
