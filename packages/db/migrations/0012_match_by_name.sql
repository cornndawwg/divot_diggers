-- =============================================================================
-- Migration 0012 — match an existing golfer by name as well as by email
--
-- Beyond the docs/schema.sql baseline.
--
-- add_org_person only ever matched on email, so importing a roster with no email
-- column created a second copy of everybody already in the archive. That is the
-- normal shape of a roster spreadsheet, and duplicating the whole group is a bad
-- way to find out.
--
-- Email still wins where there is one: it is the stronger claim. Failing that, an
-- exact name already in THIS group is taken as the same person. Two different
-- golfers with the same name in one group would be merged, which is a real if
-- unlikely cost — but silently ending up with two of every returning player is a
-- worse and far more likely one, and renaming one of them is easy.
-- =============================================================================

CREATE OR REPLACE FUNCTION add_org_person(
  target_org uuid,
  person_name text,
  person_email text DEFAULT NULL,
  person_phone text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  existing uuid;
  new_id uuid;
  clean_name text := btrim(coalesce(person_name, ''));
  clean_email text := nullif(btrim(coalesce(person_email, '')), '');
  clean_phone text := nullif(btrim(coalesce(person_phone, '')), '');
BEGIN
  IF current_person_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT is_org_member(target_org) THEN
    RAISE EXCEPTION 'You are not a member of that organization';
  END IF;
  IF clean_name = '' THEN
    RAISE EXCEPTION 'A golfer needs a name';
  END IF;

  -- The stronger claim first.
  IF clean_email IS NOT NULL THEN
    SELECT p.id INTO existing
      FROM people p
      JOIN org_members m ON m.person_id = p.id
     WHERE m.org_id = target_org AND m.removed_at IS NULL
       AND p.email = clean_email::citext
     ORDER BY p.created_at
     LIMIT 1;
  END IF;

  -- Then an exact name already in this group. Oldest first, so repeated imports
  -- consolidate onto one person rather than adding another each time.
  IF existing IS NULL THEN
    SELECT p.id INTO existing
      FROM people p
      JOIN org_members m ON m.person_id = p.id
     WHERE m.org_id = target_org AND m.removed_at IS NULL
       AND lower(btrim(p.display_name)) = lower(clean_name)
     ORDER BY p.created_at
     LIMIT 1;
  END IF;

  IF existing IS NOT NULL THEN
    -- Fill in what was blank; never overwrite what is already known.
    UPDATE people
       SET phone = coalesce(phone, clean_phone),
           email = coalesce(email, clean_email::citext)
     WHERE id = existing;
    RETURN existing;
  END IF;

  INSERT INTO people (display_name, email, phone)
  VALUES (clean_name, clean_email::citext, clean_phone)
  RETURNING id INTO new_id;

  INSERT INTO org_members (org_id, person_id, role) VALUES (target_org, new_id, 'member');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
