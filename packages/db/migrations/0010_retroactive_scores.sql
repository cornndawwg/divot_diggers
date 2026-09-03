-- =============================================================================
-- Migration 0010 — entering scores, and the derived results table
--
-- Beyond the docs/schema.sql baseline.
--
-- Backfilling a past event means writing scorecards and rebuilding the results
-- that follow from them. Neither had a write policy.
--
-- dogfight_results is a CACHE (decision 4 in docs/schema.sql): everything in it
-- is reproducible from the scorecards, so it can be dropped and rebuilt at any
-- time. It is therefore the one derived table the app may DELETE from — and the
-- reason that grant is safe is precisely that nothing is lost by it. Scores
-- themselves are never deleted by the app.
-- =============================================================================

-- A planner may enter scorecards for their event. Players entering their own
-- hole-by-hole scores already have hole_score_write from the baseline; this is the
-- planner's retroactive path, where a whole round arrives as a points total.
CREATE POLICY scorecard_write ON scorecards
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = scorecards.round_id AND has_event_role(e.id, 'planner')));

CREATE POLICY scorecard_update ON scorecards
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = scorecards.round_id AND has_event_role(e.id, 'planner')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = scorecards.round_id AND has_event_role(e.id, 'planner')));

-- The results cache. Rebuilt from scorecards, so writes are unremarkable.
CREATE POLICY dogfight_result_write ON dogfight_results
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)));

CREATE POLICY dogfight_result_update ON dogfight_results
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)));

CREATE POLICY dogfight_result_delete ON dogfight_results
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)));
