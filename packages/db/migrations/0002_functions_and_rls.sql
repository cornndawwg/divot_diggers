-- =============================================================================
-- Migration 0002 — functions, triggers, rules and Row Level Security
--
-- Ported from docs/schema.sql. Runs immediately after 0001; the two are one
-- logical unit, split only because Drizzle cannot express what is in here.
--
-- Two footguns, per docs/schema.sql: a table owner bypasses its own RLS, so the
-- API must connect as a non-owning role; and RLS with no policy denies every row
-- silently rather than erroring.
-- =============================================================================

CREATE OR REPLACE FUNCTION touch_row_version() RETURNS trigger AS $$
BEGIN
  NEW.row_version := nextval('row_version_seq');
  NEW.updated_at  := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Set per-request by the API from the authenticated session.
CREATE OR REPLACE FUNCTION current_person_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.person_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
-- Rulesets are immutable once published. Edits create a new version row.
CREATE OR REPLACE FUNCTION block_published_ruleset_update() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.document IS DISTINCT FROM OLD.document THEN
    RAISE EXCEPTION 'Published ruleset % v% is immutable; create a new version',
      OLD.key, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rulesets_immutable BEFORE UPDATE ON rulesets
  FOR EACH ROW EXECUTE FUNCTION block_published_ruleset_update();
CREATE RULE player_ratings_no_update AS ON UPDATE TO player_ratings DO INSTEAD NOTHING;
CREATE RULE player_ratings_no_delete AS ON DELETE TO player_ratings DO INSTEAD NOTHING;
-- =============================================================================
-- row_version triggers on every syncable table
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','people','org_members','rulesets','courses','tee_sets','course_holes',
    'events','event_players','rounds','tee_groups','scorecards','hole_scores',
    'dogfight_results','cup_teams','cup_team_members','cup_sessions','cup_matches',
    'cup_match_holes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_row_version BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_row_version()', t, t);
  END LOOP;
END $$;
-- Membership helpers. Defined here because SQL function bodies are validated
-- at creation time and these reference tables created above.
CREATE OR REPLACE FUNCTION is_org_member(target_org uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = target_org
      AND m.person_id = current_person_id()
      AND m.removed_at IS NULL
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
CREATE OR REPLACE FUNCTION has_event_role(target_event uuid, wanted text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM event_roles r
    WHERE r.event_id = target_event
      AND r.person_id = current_person_id()
      AND r.role = wanted
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
-- =============================================================================
-- Row Level Security
--
-- Enable on EVERY table. The adversarial test (org B cannot read org A) must be
-- written alongside these policies, not afterwards. A missing policy fails
-- silently and is the standard way a multi-tenant app leaks customer data.
--
-- TWO FOOTGUNS, both verified against a live Postgres 16:
--
--   a) A table owner BYPASSES its own RLS policies. The API must connect as a
--      non-owning role (app_user below), or every policy here is decorative.
--      Use FORCE ROW LEVEL SECURITY if the app must run as owner.
--   b) Enabling RLS with no policy denies ALL rows rather than allowing them.
--      That fails closed, which is safe, but presents as "the app shows nothing"
--      rather than as an error. schema-tests.sql asserts this count is zero.
--
--   CREATE ROLE app_user NOLOGIN;
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
--   -- per request:  SET LOCAL app.person_id = '<authenticated person uuid>';
-- =============================================================================

ALTER TABLE organizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rulesets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_players   ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_roles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_ratings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE scorecards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hole_scores     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dogfight_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_teams       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_matches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_match_holes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_mutations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_import_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_read ON organizations
  FOR SELECT USING (is_org_member(id));
CREATE POLICY member_read ON org_members
  FOR SELECT USING (is_org_member(org_id));
-- System presets (org_id IS NULL) are readable by everyone; org rulesets are not.
CREATE POLICY ruleset_read ON rulesets
  FOR SELECT USING (org_id IS NULL OR is_org_member(org_id));
CREATE POLICY ruleset_write ON rulesets
  FOR ALL USING (org_id IS NOT NULL AND is_org_member(org_id))
           WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id));
-- Shared course library is world-readable; org-private courses are not.
CREATE POLICY course_read ON courses
  FOR SELECT USING (org_id IS NULL OR is_org_member(org_id));
-- Belt and braces: a licensed row may never be promoted to the shared library.
CREATE OR REPLACE FUNCTION block_licensed_in_shared_library() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.provenance = 'licensed' THEN
    RAISE EXCEPTION 'Licensed course data cannot be published to the shared library';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER courses_license_guard BEFORE INSERT OR UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION block_licensed_in_shared_library();
CREATE POLICY event_read ON events
  FOR SELECT USING (is_org_member(org_id));
CREATE POLICY event_write ON events
  FOR ALL USING (has_event_role(id, 'planner'))
           WITH CHECK (has_event_role(id, 'planner'));
CREATE POLICY event_player_read ON event_players
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = event_players.event_id AND is_org_member(e.org_id)));
CREATE POLICY rating_read ON player_ratings
  FOR SELECT USING (is_org_member(org_id));
CREATE POLICY round_read ON rounds
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = rounds.event_id AND is_org_member(e.org_id)));
CREATE POLICY scorecard_read ON scorecards
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
    WHERE r.id = scorecards.round_id AND is_org_member(e.org_id)));
-- Anyone in the same tee group may enter or amend a score. entered_by records who.
CREATE POLICY hole_score_read ON hole_scores
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM scorecards s JOIN rounds r ON r.id = s.round_id
    JOIN events e ON e.id = r.event_id
    WHERE s.id = hole_scores.scorecard_id AND is_org_member(e.org_id)));
CREATE POLICY hole_score_write ON hole_scores
  FOR ALL USING (EXISTS (
    SELECT 1
    FROM scorecards s
    JOIN tee_group_members tgm_target ON tgm_target.event_player_id = s.event_player_id
    JOIN tee_groups tg ON tg.id = tgm_target.tee_group_id AND tg.round_id = s.round_id
    JOIN tee_group_members tgm_self ON tgm_self.tee_group_id = tg.id
    JOIN event_players ep ON ep.id = tgm_self.event_player_id
    WHERE s.id = hole_scores.scorecard_id AND ep.person_id = current_person_id()));
CREATE POLICY sync_own ON sync_mutations
  FOR ALL USING (person_id = current_person_id())
           WITH CHECK (person_id = current_person_id());
-- Cup and results tables: readable by anyone in the owning organization.
CREATE POLICY event_role_read ON event_roles
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = event_roles.event_id AND is_org_member(e.org_id)));
CREATE POLICY dogfight_result_read ON dogfight_results
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
    WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)));
CREATE POLICY cup_team_read ON cup_teams
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = cup_teams.event_id AND is_org_member(e.org_id)));
CREATE POLICY cup_match_read ON cup_matches
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_sessions cs JOIN events e ON e.id = cs.event_id
    WHERE cs.id = cup_matches.cup_session_id AND is_org_member(e.org_id)));
CREATE POLICY cup_match_hole_read ON cup_match_holes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_matches cm JOIN cup_sessions cs ON cs.id = cm.cup_session_id
    JOIN events e ON e.id = cs.event_id
    WHERE cm.id = cup_match_holes.cup_match_id AND is_org_member(e.org_id)));
-- Players in a match may record its holes.
CREATE POLICY cup_match_hole_write ON cup_match_holes
  FOR ALL USING (EXISTS (
    SELECT 1 FROM cup_match_players cmp
    JOIN event_players ep ON ep.id = cmp.event_player_id
    WHERE cmp.cup_match_id = cup_match_holes.cup_match_id
      AND ep.person_id = current_person_id()));
CREATE POLICY course_import_member ON course_import_jobs
  FOR ALL USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
