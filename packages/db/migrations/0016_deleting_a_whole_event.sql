-- 0016  Let a whole event be deleted, without letting one scored player be quietly removed.
--
-- 0008 added a trigger refusing to delete an event_players row that has scores against it.
-- That is right for what it was written for: a planner taking somebody off the roster must
-- not silently take their scorecards with them.
--
-- It also fires when the entire event is deleted, because that cascades to event_players.
-- So an event became undeletable the moment anybody's first score was entered — a planner
-- who set one up by mistake, or a group abandoning a year, was stuck with it for good. The
-- same shape of problem as 0015: a per-row guard also standing in the way of a cascade the
-- schema itself declares.
--
-- The guard now steps aside when the event it belongs to has already gone, which is true
-- inside the cascade of a DELETE on events and false for anybody removing a single player.
-- Removing one scored player is refused exactly as before.

CREATE OR REPLACE FUNCTION block_delete_of_scored_player() RETURNS trigger AS $$
DECLARE
  hole_count integer;
  total_count integer;
BEGIN
  -- The whole event is going. Its scores are meant to go with it.
  IF NOT EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id) THEN
    RETURN OLD;
  END IF;

  SELECT count(*) INTO hole_count
    FROM hole_scores h JOIN scorecards s ON s.id = h.scorecard_id
   WHERE s.event_player_id = OLD.id;

  SELECT count(*) INTO total_count
    FROM scorecards s
   WHERE s.event_player_id = OLD.id
     AND (s.points_pulled_manual IS NOT NULL OR s.status <> 'not_started');

  IF hole_count > 0 OR total_count > 0 THEN
    RAISE EXCEPTION
      'This player already has scores recorded, so removing them would delete those scores. Mark them as not playing instead.';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
