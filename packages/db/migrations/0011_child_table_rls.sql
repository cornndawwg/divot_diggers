-- =============================================================================
-- Migration 0011 — Row Level Security on the remaining child tables
--
-- Beyond the docs/schema.sql baseline. This closes a real cross-tenant leak.
--
-- The baseline enables RLS on seventeen tables and leaves ten without it. I had
-- assumed those were safe because they are only reachable through a parent that
-- IS protected. That assumption was wrong: with no policy at all, a plain
-- `SELECT * FROM course_holes` returns every row in the database regardless of
-- who is asking. Measured before writing this — an outsider could read all 567
-- holes of every private course, all 32 tee sets, and every tee group.
--
-- Invariant #5 says RLS on every table, no exceptions. This is that.
--
-- Each policy tests EXISTS against the parent rather than restating the parent's
-- rule. A subquery inside a policy is itself subject to the parent's policies, so
-- a child row is visible exactly when its parent is, and the two can never drift
-- apart. Writes are narrower than reads on purpose: the shared course library is
-- world-readable, and world-readable must not mean world-writable.
-- =============================================================================

-- --- course structure -------------------------------------------------------

ALTER TABLE tee_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tee_set_read ON tee_sets
  FOR SELECT USING (EXISTS (SELECT 1 FROM courses c WHERE c.id = tee_sets.course_id));
CREATE POLICY tee_set_write ON tee_sets
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = tee_sets.course_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)));
CREATE POLICY tee_set_update ON tee_sets
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = tee_sets.course_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = tee_sets.course_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)));

ALTER TABLE course_holes ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_hole_read ON course_holes
  FOR SELECT USING (EXISTS (SELECT 1 FROM tee_sets t WHERE t.id = course_holes.tee_set_id));
CREATE POLICY course_hole_write ON course_holes
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM tee_sets t JOIN courses c ON c.id = t.course_id
     WHERE t.id = course_holes.tee_set_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)));
CREATE POLICY course_hole_update ON course_holes
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM tee_sets t JOIN courses c ON c.id = t.course_id
     WHERE t.id = course_holes.tee_set_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tee_sets t JOIN courses c ON c.id = t.course_id
     WHERE t.id = course_holes.tee_set_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)));

ALTER TABLE course_nines ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_nine_read ON course_nines
  FOR SELECT USING (EXISTS (SELECT 1 FROM courses c WHERE c.id = course_nines.course_id));
CREATE POLICY course_nine_write ON course_nines
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = course_nines.course_id AND c.org_id IS NOT NULL AND is_org_member(c.org_id)));

-- --- round structure --------------------------------------------------------

ALTER TABLE round_competitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY round_competition_read ON round_competitions
  FOR SELECT USING (EXISTS (SELECT 1 FROM rounds r WHERE r.id = round_competitions.round_id));
CREATE POLICY round_competition_write ON round_competitions
  FOR ALL USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = round_competitions.round_id AND has_event_role(e.id, 'planner')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = round_competitions.round_id AND has_event_role(e.id, 'planner')));

-- Tee times say who is playing with whom and when. Not everybody's business.
ALTER TABLE tee_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tee_group_read ON tee_groups
  FOR SELECT USING (EXISTS (SELECT 1 FROM rounds r WHERE r.id = tee_groups.round_id));
CREATE POLICY tee_group_write ON tee_groups
  FOR ALL USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = tee_groups.round_id AND has_event_role(e.id, 'planner')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = tee_groups.round_id AND has_event_role(e.id, 'planner')));

ALTER TABLE tee_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tee_group_member_read ON tee_group_members
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM tee_groups g WHERE g.id = tee_group_members.tee_group_id));
CREATE POLICY tee_group_member_write ON tee_group_members
  FOR ALL USING (EXISTS (
    SELECT 1 FROM tee_groups g JOIN rounds r ON r.id = g.round_id
     JOIN events e ON e.id = r.event_id
     WHERE g.id = tee_group_members.tee_group_id AND has_event_role(e.id, 'planner')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tee_groups g JOIN rounds r ON r.id = g.round_id
     JOIN events e ON e.id = r.event_id
     WHERE g.id = tee_group_members.tee_group_id AND has_event_role(e.id, 'planner')));

-- --- cup structure ----------------------------------------------------------

ALTER TABLE cup_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cup_session_read ON cup_sessions
  FOR SELECT USING (EXISTS (SELECT 1 FROM events e WHERE e.id = cup_sessions.event_id));

ALTER TABLE cup_team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY cup_team_member_read ON cup_team_members
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_teams t WHERE t.id = cup_team_members.cup_team_id));

ALTER TABLE cup_match_players ENABLE ROW LEVEL SECURITY;
CREATE POLICY cup_match_player_read ON cup_match_players
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_matches m WHERE m.id = cup_match_players.cup_match_id));

-- --- the score audit trail --------------------------------------------------

ALTER TABLE hole_score_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY hole_score_audit_read ON hole_score_audit
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM hole_scores h WHERE h.id = hole_score_audit.hole_score_id));
CREATE POLICY hole_score_audit_write ON hole_score_audit
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM hole_scores h WHERE h.id = hole_score_audit.hole_score_id));
