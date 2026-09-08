#!/usr/bin/env bash
# Remove development leftovers from the dev database: test events and duplicate courses.
#
# Shows exactly what it will remove and asks before removing it. Touches nothing that has a
# scorecard against it, and nothing outside the two categories below.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

echo "Database: $(psql "$DATABASE_URL" -qtAc 'SELECT current_database()')"
echo
echo "Events named 'Wiz ...' (created by the test suite), with no scorecards:"
psql "$DATABASE_URL" -c "
SELECT e.name, e.year,
       (SELECT count(*) FROM rounds r WHERE r.event_id = e.id) AS rounds,
       (SELECT count(*) FROM scorecards s JOIN rounds r ON r.id = s.round_id
         WHERE r.event_id = e.id) AS scorecards
  FROM events e WHERE e.name LIKE 'Wiz %'"

echo "Duplicate courses (same name in the same group), keeping the oldest of each:"
psql "$DATABASE_URL" -c "
SELECT c.name, c.created_at,
       (SELECT count(*) FROM rounds r WHERE r.course_id = c.id) AS rounds
  FROM courses c
 WHERE EXISTS (SELECT 1 FROM courses o
                WHERE o.org_id = c.org_id AND lower(o.name) = lower(c.name)
                  AND o.created_at < c.created_at)
 ORDER BY c.name, c.created_at"

read -r -p "Remove these? Type the database name to confirm: " answer
expected=$(psql "$DATABASE_URL" -qtAc 'SELECT current_database()')
if [ "$answer" != "$expected" ]; then
  echo "Not confirmed. Nothing was removed."
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM events e
 WHERE e.name LIKE 'Wiz %'
   AND NOT EXISTS (SELECT 1 FROM scorecards s JOIN rounds r ON r.id = s.round_id
                    WHERE r.event_id = e.id);
DELETE FROM courses c
 WHERE EXISTS (SELECT 1 FROM courses o
                WHERE o.org_id = c.org_id AND lower(o.name) = lower(c.name)
                  AND o.created_at < c.created_at)
   AND NOT EXISTS (SELECT 1 FROM rounds r WHERE r.course_id = c.id);
COMMIT;
SQL

echo
echo "Left behind:"
psql "$DATABASE_URL" -c "
SELECT c.name, count(DISTINCT t.id) AS tee_sets FROM courses c
  LEFT JOIN tee_sets t ON t.course_id = c.id GROUP BY c.name ORDER BY c.name"
psql "$DATABASE_URL" -c "SELECT year, name FROM events ORDER BY year, name"
