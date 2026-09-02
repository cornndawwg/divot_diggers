#!/usr/bin/env bash
#
# Proves the BASELINE migrations reproduce docs/schema.sql exactly, and that the full
# migration set applies cleanly on top.
#
# docs/schema.sql is the authority for the baseline. 0001 and 0002 are a split of it,
# so any difference there means the port drifted and must be corrected in the
# migrations, never in docs/schema.sql.
#
# Later migrations are deliberate changes beyond the baseline. They are expected to
# differ from docs/schema.sql; each one says why in its header, and its behaviour is
# asserted by the Vitest suite rather than by a schema diff.
#
#   ./scripts/verify-migration.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

REF_DB="ddga_ref"
MIG_DB="ddga_migrated"
FULL_DB="ddga_full"

# The migrations that must match docs/schema.sql byte for byte.
BASELINE=(0001_tables.sql 0002_functions_and_rls.sql)

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

echo "Building baseline database from the baseline migrations ..."
rebuild "$MIG_DB"
mig_errors=0
for name in "${BASELINE[@]}"; do
  f="packages/db/migrations/${name}"
  [[ -f "$f" ]] || { echo "FAIL: baseline migration $name is missing." >&2; exit 1; }
  out=$(psql "${BASE}/${MIG_DB}" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  errs=$(printf '%s\n' "$out" | grep -c 'ERROR:')
  mig_errors=$(( mig_errors + errs ))
  [[ $errs -eq 0 ]] || { echo "  in $f:"; printf '%s\n' "$out" | grep 'ERROR:' | head -5; }
done

echo "Building full database from every migration ..."
rebuild "$FULL_DB"
full_errors=0
shopt -s nullglob
migrations=(packages/db/migrations/*.sql)
[[ ${#migrations[@]} -gt 0 ]] || { echo "FAIL: no migrations found." >&2; exit 1; }
for f in "${migrations[@]}"; do
  out=$(psql "${BASE}/${FULL_DB}" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1)
  errs=$(printf '%s\n' "$out" | grep -c 'ERROR:')
  full_errors=$(( full_errors + errs ))
  [[ $errs -eq 0 ]] || { echo "  in $f:"; printf '%s\n' "$out" | grep 'ERROR:' | head -5; }
done

check() {
  if [[ "$2" == "$3" ]]; then printf '  PASS  %-46s %s\n' "$1" "$3"
  else printf '  FAIL  %-46s got %s, expected %s\n' "$1" "$3" "$2"; fail=1; fi
}

echo
echo "=== results ==="
check "baseline migrations apply with no errors" "0" "$mig_errors"
check "all migrations apply with no errors" "0" "$full_errors"
check "reference schema applies with no errors" "0" "$ref_errors"
printf '  INFO  %-46s %s\n' "baseline migrations" "${#BASELINE[@]}"
printf '  INFO  %-46s %s\n' "migrations in total" "${#migrations[@]}"

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
  printf '  PASS  %-46s %s lines\n' "baseline dump identical to docs/schema.sql" "$(wc -l < "$tmp/ref.sql")"
else
  printf '  FAIL  %-46s\n' "baseline dump identical to docs/schema.sql"
  fail=1
  echo
  echo "--- differences (reference vs migrated) ---"
  diff -u "$tmp/ref.sql" "$tmp/mig.sql" | head -60
fi

if [[ ${#migrations[@]} -gt ${#BASELINE[@]} ]]; then
  echo
  echo "=== deliberate changes beyond the baseline ==="
  for f in "${migrations[@]}"; do
    name=$(basename "$f")
    skip=0
    for b in "${BASELINE[@]}"; do [[ "$name" == "$b" ]] && skip=1; done
    [[ $skip -eq 1 ]] && continue
    printf '  %s\n' "$name"
  done
  normalise "${BASE}/${FULL_DB}" > "$tmp/full.sql"
  added=$(diff "$tmp/mig.sql" "$tmp/full.sql" | grep -c '^>')
  removed=$(diff "$tmp/mig.sql" "$tmp/full.sql" | grep -c '^<')
  printf '  %s schema lines added, %s removed relative to the baseline\n' "$added" "$removed"
fi

echo
[[ $fail -eq 0 ]] && echo "MIGRATION VERIFICATION PASSED" || echo "MIGRATION VERIFICATION FAILED"
exit $fail
