-- 0022  Removing a round that should never have existed.
--
-- A round scheduled by mistake was permanent. Deleting one takes its scorecards, tee groups,
-- cup sessions and cached results with it, because every one of those references it with ON
-- DELETE CASCADE — which is right, and is exactly why it needs a guard.
--
-- The rule is the same one the edit path uses: while nobody has been scored, a round is just
-- a plan and removing it loses nothing. Once somebody has a card, it is a record of what
-- people did, and the answer is to correct it rather than delete it.
--
-- The guard steps aside when the event itself is going. That is the lesson of 0016: a
-- per-row trigger that does not consider the cascade above it makes the parent undeletable,
-- and that took a day to find the first time.

CREATE OR REPLACE FUNCTION block_delete_of_scored_round() RETURNS trigger AS $$
DECLARE
  scored integer;
BEGIN
  -- The whole event is going, and its rounds are meant to go with it.
  IF NOT EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id) THEN
    RETURN OLD;
  END IF;

  SELECT count(*) INTO scored
    FROM scorecards s
   WHERE s.round_id = OLD.id
     AND (s.points_pulled_manual IS NOT NULL OR s.status <> 'not_started');

  IF scored > 0 THEN
    RAISE EXCEPTION
      'This round already has scores against it, so removing it would delete them. Correct the round instead.';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rounds_protect_scores ON rounds;
CREATE TRIGGER rounds_protect_scores BEFORE DELETE ON rounds
  FOR EACH ROW EXECUTE FUNCTION block_delete_of_scored_round();

-- rounds carried policies for select, insert and update and none for delete, so row level
-- security refused every attempt — invisibly, as a row count of zero rather than an error.
-- Whoever may administer the event may remove one; the trigger above decides whether it is
-- allowed to go.
DROP POLICY IF EXISTS round_delete ON rounds;
CREATE POLICY round_delete ON rounds
  FOR DELETE USING (has_event_role(event_id, 'planner'));
