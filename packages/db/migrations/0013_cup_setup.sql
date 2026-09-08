-- =============================================================================
-- Migration 0013 — the planner can set up the cup
--
-- Beyond the docs/schema.sql baseline.
--
-- cup_teams, cup_team_members and cup_sessions were readable and nothing more,
-- so a planner could not name the two sides, appoint captains, or put anybody on
-- a team. The engine has played match play since task 1.7 and the tables have
-- existed since the baseline; this is the missing half.
--
-- Naming the sides and picking who is on them is the planner's job. Drafting at
-- a table with two captains taking turns is task 4.1 and is a different thing —
-- these policies allow both, since a draft is also a planner-run event.
-- =============================================================================

CREATE POLICY cup_team_write ON cup_teams
  FOR INSERT WITH CHECK (has_event_role(cup_teams.event_id, 'planner'));

CREATE POLICY cup_team_update ON cup_teams
  FOR UPDATE USING (has_event_role(cup_teams.event_id, 'planner'))
             WITH CHECK (has_event_role(cup_teams.event_id, 'planner'));

CREATE POLICY cup_team_delete ON cup_teams
  FOR DELETE USING (has_event_role(cup_teams.event_id, 'planner'));

CREATE POLICY cup_team_member_write ON cup_team_members
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM cup_teams t
     WHERE t.id = cup_team_members.cup_team_id AND has_event_role(t.event_id, 'planner')));

CREATE POLICY cup_team_member_delete ON cup_team_members
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM cup_teams t
     WHERE t.id = cup_team_members.cup_team_id AND has_event_role(t.event_id, 'planner')));

CREATE POLICY cup_session_write ON cup_sessions
  FOR INSERT WITH CHECK (has_event_role(cup_sessions.event_id, 'planner'));

CREATE POLICY cup_session_update ON cup_sessions
  FOR UPDATE USING (has_event_role(cup_sessions.event_id, 'planner'))
             WITH CHECK (has_event_role(cup_sessions.event_id, 'planner'));
