-- =============================================================================
-- Migration 0005 — write policies for the planner paths
--
-- Beyond the docs/schema.sql baseline.
--
-- The baseline gives eleven tables a SELECT policy and no write policy, so the
-- console could read but never create anything as the non-owning role the API
-- connects with. Two of those are worse than merely missing:
--
--   * `events` has event_write FOR ALL, but its check is
--     has_event_role(id, 'planner') — which for an INSERT asks whether you are
--     already a planner of an event that does not exist yet. Never satisfiable.
--   * `organizations` has no INSERT policy at all, so a new group could not be
--     created, and without a group RLS hides everything else.
--
-- Both bootstrap problems are solved with SECURITY DEFINER functions rather than
-- permissive INSERT policies. A function creates the row AND the membership or
-- role that grants access to it, atomically, so there is no window where a row
-- exists that nobody may reach — and no policy loose enough to let a person
-- insert a row they are not entitled to.
--
-- SCOPE. Only the paths task 2.4b needs: creating a group, creating a course,
-- creating an event, creating a round. The cup and scorecard tables are still
-- read-only here; their write policies belong with the tasks that build them,
-- where the adversarial tests can be written alongside (invariant #5).
-- =============================================================================

-- Create a group and make the caller its owner, in one statement.
CREATE OR REPLACE FUNCTION create_organization(org_name text, org_slug text)
RETURNS uuid AS $$
DECLARE
  new_id uuid;
  person uuid := current_person_id();
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in, so there is nobody to own the new group';
  END IF;

  INSERT INTO organizations (name, slug) VALUES (org_name, org_slug)
  RETURNING id INTO new_id;

  INSERT INTO org_members (org_id, person_id, role) VALUES (new_id, person, 'owner');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create an event and make the caller its planner, in one statement. A member of
-- the organization may do this; being a planner of the new event is the result,
-- not the precondition.
CREATE OR REPLACE FUNCTION create_event(target_org uuid, event_name text, event_year integer)
RETURNS uuid AS $$
DECLARE
  new_id uuid;
  person uuid := current_person_id();
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT is_org_member(target_org) THEN
    RAISE EXCEPTION 'You are not a member of that organization';
  END IF;

  INSERT INTO events (org_id, name, year, status) VALUES (target_org, event_name, event_year, 'draft')
  RETURNING id INTO new_id;

  -- A planner is usually also playing.
  INSERT INTO event_roles (event_id, person_id, role) VALUES (new_id, person, 'planner');
  INSERT INTO event_roles (event_id, person_id, role) VALUES (new_id, person, 'player');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- A member may add a course to their own organization. Note org_id IS NOT NULL:
-- the shared cross-tenant library is not writable from an end-user session.
CREATE POLICY course_write ON courses
  FOR INSERT WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id));

CREATE POLICY course_update ON courses
  FOR UPDATE USING (org_id IS NOT NULL AND is_org_member(org_id))
              WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id));

-- Rounds belong to an event, and shaping an event is the planner's job.
CREATE POLICY round_write ON rounds
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM events e WHERE e.id = rounds.event_id AND has_event_role(e.id, 'planner')));

CREATE POLICY round_update ON rounds
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = rounds.event_id AND has_event_role(e.id, 'planner')))
              WITH CHECK (EXISTS (
    SELECT 1 FROM events e WHERE e.id = rounds.event_id AND has_event_role(e.id, 'planner')));
