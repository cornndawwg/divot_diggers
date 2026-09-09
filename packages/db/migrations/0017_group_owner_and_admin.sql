-- 0017  Group Owner and Group Admin: authority over a group, not one event at a time.
--
-- Until now the only way to hold any authority was to create an event, because create_event
-- granted its creator the event-level 'planner' role and nothing else ever granted it. So:
--
--   * a group's owner could not administer an event somebody else had created,
--   * there was no way to give anyone else authority over anything, ever, and
--   * an ordinary member could create an event and become its administrator.
--
-- Authority now lives on the group, where it belongs. A group has one or more **owners** and
-- any number of **admins**; both may administer every event the group has ever run, and no
-- per-event grant is needed or issued. Captain and player stay per-event, because they are
-- genuinely about one event.
--
-- Thirty-four write policies ask `has_event_role(id, 'planner')`. Rather than rewrite all of
-- them, the question that function answers for 'planner' is widened from "were you named
-- planner of this event" to "may you administer this event" — which a group's owners and
-- admins may, by virtue of running the group. Captain is deliberately untouched: a Group
-- Admin does not thereby captain a side.

CREATE OR REPLACE FUNCTION has_event_role(target_event uuid, wanted text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM event_roles r
     WHERE r.event_id = target_event
       AND r.person_id = current_person_id()
       AND r.role = wanted
  )
  -- Administering an event is a group-level authority. Anyone who runs the group runs its
  -- events, including ones created before they were given the role.
  OR (wanted = 'planner' AND EXISTS (
    SELECT 1 FROM events e
      JOIN org_members m ON m.org_id = e.org_id
     WHERE e.id = target_event
       AND m.person_id = current_person_id()
       AND m.removed_at IS NULL
       AND m.role IN ('owner', 'admin')
  ));
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Creating an event is administering the group, so it takes a Group Owner or Group Admin.
-- The creator is no longer given an event-level planner role: their authority comes from the
-- group, so that it can be taken away by changing their group role and nothing is left
-- behind granting rights on events they happened to create.
CREATE OR REPLACE FUNCTION create_event(target_org uuid, event_name text, event_year integer)
RETURNS uuid AS $$
DECLARE
  new_id uuid;
  person uuid := current_person_id();
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT is_org_admin(target_org) THEN
    RAISE EXCEPTION 'Only a group owner or group admin can create an event';
  END IF;

  INSERT INTO events (org_id, name, year, status) VALUES (target_org, event_name, event_year, 'draft')
  RETURNING id INTO new_id;

  -- Whoever sets the event up is usually playing in it too.
  INSERT INTO event_roles (event_id, person_id, role) VALUES (new_id, person, 'player');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Give somebody a role in the group, or change the one they have.
--
-- Only an owner may appoint or remove another owner: an admin promoting themselves to owner
-- would make the distinction meaningless.
CREATE OR REPLACE FUNCTION set_org_role(target_org uuid, target_person uuid, new_role text)
RETURNS void AS $$
DECLARE
  caller uuid := current_person_id();
  caller_role text;
  existing_role text;
  owners integer;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF new_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'A group role is owner, admin or member, not %', new_role;
  END IF;

  SELECT role INTO caller_role FROM org_members
   WHERE org_id = target_org AND person_id = caller AND removed_at IS NULL;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only a group owner or group admin can change who does what';
  END IF;

  SELECT role INTO existing_role FROM org_members
   WHERE org_id = target_org AND person_id = target_person AND removed_at IS NULL;

  IF caller_role <> 'owner' AND (new_role = 'owner' OR existing_role = 'owner') THEN
    RAISE EXCEPTION 'Only a group owner can appoint or replace an owner';
  END IF;

  -- A group with no owner cannot appoint one, so never let the last one step down.
  IF existing_role = 'owner' AND new_role <> 'owner' THEN
    SELECT count(*) INTO owners FROM org_members
     WHERE org_id = target_org AND role = 'owner' AND removed_at IS NULL;
    IF owners <= 1 THEN
      RAISE EXCEPTION 'This is the group''s only owner. Make somebody else an owner first.';
    END IF;
  END IF;

  INSERT INTO org_members (org_id, person_id, role) VALUES (target_org, target_person, new_role)
  ON CONFLICT (org_id, person_id)
    DO UPDATE SET role = excluded.role, removed_at = NULL, updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
