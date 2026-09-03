-- =============================================================================
-- Migration 0006 — the player archive
--
-- Beyond the docs/schema.sql baseline.
--
-- A planner building next year's roster should pick from the people they already
-- know rather than retyping two dozen names and phone numbers. The baseline
-- schema already models this correctly — `people` is global identity,
-- `org_members` grants a group access to a person, `event_players` scopes them to
-- one event — so the archive is a query, not a new table. What was missing was
-- any way to write to it.
--
-- Contact details live on `people` and are readable only by those sharing an
-- organization (migration 0003). That is what makes the archive a safe place to
-- keep a phone number for chasing confirmations.
-- =============================================================================

-- Add a golfer to a group's archive, or return the one already there.
--
-- SECURITY DEFINER for the same reason create_organization is: it writes the
-- person AND the membership that grants access to them, together. A bare INSERT
-- policy on `people` would let anyone create person rows unattached to anything.
--
-- Matching is scoped to THIS organization on purpose. Unifying one golfer across
-- two groups is a real goal (spec part 3) but it needs the person's consent, and
-- silently attaching a stranger's name and phone number to a group because an
-- email happened to match is not consent. Cross-group identity arrives when the
-- golfer signs up and verifies the address themselves — see the claim path in
-- the API's auth hooks.
CREATE OR REPLACE FUNCTION add_org_person(
  target_org uuid,
  person_name text,
  person_email text DEFAULT NULL,
  person_phone text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  existing uuid;
  new_id uuid;
BEGIN
  IF current_person_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT is_org_member(target_org) THEN
    RAISE EXCEPTION 'You are not a member of that organization';
  END IF;
  IF person_name IS NULL OR btrim(person_name) = '' THEN
    RAISE EXCEPTION 'A golfer needs a name';
  END IF;

  -- Already in this group's archive? Return them rather than making a second row.
  IF person_email IS NOT NULL AND btrim(person_email) <> '' THEN
    SELECT p.id INTO existing
      FROM people p
      JOIN org_members m ON m.person_id = p.id
     WHERE m.org_id = target_org
       AND m.removed_at IS NULL
       AND p.email = person_email::citext
     LIMIT 1;

    IF existing IS NOT NULL THEN
      -- Fill in details that were blank, without overwriting anything.
      UPDATE people
         SET phone = coalesce(phone, person_phone),
             display_name = CASE WHEN btrim(display_name) = '' THEN person_name ELSE display_name END
       WHERE id = existing;
      RETURN existing;
    END IF;
  END IF;

  INSERT INTO people (display_name, email, phone)
  VALUES (
    btrim(person_name),
    nullif(btrim(coalesce(person_email, '')), '')::citext,
    nullif(btrim(coalesce(person_phone, '')), '')
  )
  RETURNING id INTO new_id;

  INSERT INTO org_members (org_id, person_id, role) VALUES (target_org, new_id, 'member');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Claim an archived golfer when they sign up and verify that address themselves.
--
-- Called only after email verification, never at sign-up: verification is the
-- point at which control of the address is proven, and linking earlier would let
-- anyone who typed a known email inherit that golfer's rating history.
CREATE OR REPLACE FUNCTION claim_person_for_auth_user(
  auth_id text,
  person_email text,
  fallback_name text
) RETURNS uuid AS $$
DECLARE
  claimed uuid;
BEGIN
  -- Already linked, so nothing to do.
  SELECT id INTO claimed FROM people WHERE auth_user_id = auth_id;
  IF claimed IS NOT NULL THEN
    RETURN claimed;
  END IF;

  -- An archived golfer with this address and no account yet.
  SELECT id INTO claimed
    FROM people
   WHERE email = person_email::citext
     AND auth_user_id IS NULL
   ORDER BY created_at
   LIMIT 1;

  IF claimed IS NOT NULL THEN
    UPDATE people SET auth_user_id = auth_id WHERE id = claimed;
    RETURN claimed;
  END IF;

  INSERT INTO people (auth_user_id, display_name, email)
  VALUES (auth_id, fallback_name, person_email::citext)
  RETURNING id INTO claimed;

  RETURN claimed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rosters are the planner's to shape.
CREATE POLICY event_player_write ON event_players
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_players.event_id AND has_event_role(e.id, 'planner')));

CREATE POLICY event_player_update ON event_players
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_players.event_id AND has_event_role(e.id, 'planner')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_players.event_id AND has_event_role(e.id, 'planner')));

CREATE POLICY event_role_write ON event_roles
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM events e
     WHERE e.id = event_roles.event_id AND has_event_role(e.id, 'planner')));

-- A rating is written when a roster entry is seeded, and the lineage is append-only.
CREATE POLICY rating_write ON player_ratings
  FOR INSERT WITH CHECK (is_org_member(org_id));
