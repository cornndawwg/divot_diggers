-- 0014  Let a captain arrange the tee sheet, not just the planner.
--
-- Who plays with whom is the competition itself in a team event, and it is the captain's
-- decision rather than the planner's. Until now only a planner could write tee_groups, which
-- meant a captain wanting to change a pairing had to go and find them. Both roles may now
-- arrange a sheet; locking it is still what stops further change, and that is unchanged.
--
-- Read access is untouched. So is every other table: a captain gains no power over the
-- roster, the scores, or the other side's business.

DROP POLICY IF EXISTS tee_group_write ON tee_groups;
CREATE POLICY tee_group_write ON tee_groups
  FOR ALL USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = tee_groups.round_id
       AND (has_event_role(e.id, 'planner') OR has_event_role(e.id, 'captain'))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
     WHERE r.id = tee_groups.round_id
       AND (has_event_role(e.id, 'planner') OR has_event_role(e.id, 'captain'))));

DROP POLICY IF EXISTS tee_group_member_write ON tee_group_members;
CREATE POLICY tee_group_member_write ON tee_group_members
  FOR ALL USING (EXISTS (
    SELECT 1 FROM tee_groups g JOIN rounds r ON r.id = g.round_id
     JOIN events e ON e.id = r.event_id
     WHERE g.id = tee_group_members.tee_group_id
       AND (has_event_role(e.id, 'planner') OR has_event_role(e.id, 'captain'))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tee_groups g JOIN rounds r ON r.id = g.round_id
     JOIN events e ON e.id = r.event_id
     WHERE g.id = tee_group_members.tee_group_id
       AND (has_event_role(e.id, 'planner') OR has_event_role(e.id, 'captain'))));
