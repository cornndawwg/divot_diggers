-- 0021  A round that is just golf.
--
-- The first day of a trip is usually a practice round: everyone arrives, plays eighteen,
-- gets a feel for the place, and none of it counts. The scoring machinery already handles
-- this — standings only read rounds whose key the ruleset names, so a round it does not name
-- is invisible to them — but nothing said that was on purpose.
--
-- That matters because "this round feeds no competition" was a real bug not long ago: rounds
-- were being created that fed nothing and silently scored nothing, and the fix was to write
-- round_competitions properly. Without a marker, a deliberate practice round and that bug
-- look exactly alike, to a person reading the screen and to anybody debugging it later.

ALTER TABLE rounds ADD COLUMN IF NOT EXISTS is_practice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN rounds.is_practice IS
  'A round played for its own sake. Feeds no competition by design, and the absence of '
  'round_competitions rows is intended rather than a misconfiguration.';
