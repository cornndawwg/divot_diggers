-- =============================================================================
-- Migration 0008 — removing players, from a roster and from the archive
--
-- Beyond the docs/schema.sql baseline.
--
-- People drop out. They skip a year, they fall out with the group, they die. The
-- archive has to be maintainable or it becomes a list nobody trusts.
--
-- TWO DIFFERENT ACTIONS, deliberately:
--
--   Removing from a ROSTER is a real delete of the event_players row. But
--   scorecards references event_player_id ON DELETE CASCADE, so deleting a
--   player who has already been scored would silently destroy those scores. A
--   trigger refuses that outright rather than trusting every caller to check.
--
--   Removing from the ARCHIVE is a soft removal: org_members.removed_at, which
--   the baseline schema already carries and which is_org_member already honours.
--   Their player_ratings survive untouched, because that is the PTP lineage and
--   it has to be reconstructable forever (decision 2 in docs/schema.sql). Someone
--   who drops off for three years and comes back still has their rating waiting.
-- =============================================================================

-- Owners and admins manage the archive; ordinary members do not.
CREATE OR REPLACE FUNCTION is_org_admin(target_org uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members m
     WHERE m.org_id = target_org
       AND m.person_id = current_person_id()
       AND m.removed_at IS NULL
       AND m.role IN ('owner', 'admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Refuse to delete a roster entry that has scores hanging off it. Without this,
-- the cascade would take the scorecard and every hole with it.
CREATE OR REPLACE FUNCTION block_delete_of_scored_player() RETURNS trigger AS $$
DECLARE
  hole_count integer;
  total_count integer;
BEGIN
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

CREATE TRIGGER event_players_protect_scores BEFORE DELETE ON event_players
  FOR EACH ROW EXECUTE FUNCTION block_delete_of_scored_player();

-- The planner shapes the roster, including taking people off it.
CREATE POLICY event_player_delete ON event_players
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_players.event_id AND has_event_role(e.id, 'planner')));

CREATE POLICY event_role_delete ON event_roles
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_roles.event_id AND has_event_role(e.id, 'planner')));

-- Soft removal from the archive, and putting someone back.
CREATE POLICY member_update ON org_members
  FOR UPDATE USING (is_org_admin(org_id)) WITH CHECK (is_org_admin(org_id));
