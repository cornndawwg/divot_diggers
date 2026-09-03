-- =============================================================================
-- Migration 0007 — make a group's slug unique without blocking the name
--
-- `organizations.slug` is UNIQUE across the whole table, not per tenant, so the
-- first group to call itself "Divot Diggers" claimed that slug for everybody.
-- A second, unrelated group with the same name could not be created at all, and
-- the unique violation surfaced as a 500.
--
-- Two groups are perfectly entitled to the same NAME — the slug is a URL
-- convenience, not an identity — so the function now finds a free slug rather
-- than failing. The name is stored exactly as typed.
-- =============================================================================

CREATE OR REPLACE FUNCTION create_organization(org_name text, org_slug text)
RETURNS uuid AS $$
DECLARE
  new_id uuid;
  person uuid := current_person_id();
  candidate text;
  suffix integer := 1;
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in, so there is nobody to own the new group';
  END IF;
  IF org_name IS NULL OR btrim(org_name) = '' THEN
    RAISE EXCEPTION 'A group needs a name';
  END IF;

  candidate := nullif(btrim(coalesce(org_slug, '')), '');
  IF candidate IS NULL THEN
    candidate := 'group';
  END IF;

  -- Walk to the first free slug: divot-diggers, divot-diggers-2, and so on.
  WHILE EXISTS (SELECT 1 FROM organizations o WHERE o.slug = candidate) LOOP
    suffix := suffix + 1;
    candidate := nullif(btrim(coalesce(org_slug, '')), '');
    IF candidate IS NULL THEN
      candidate := 'group';
    END IF;
    candidate := candidate || '-' || suffix::text;
  END LOOP;

  INSERT INTO organizations (name, slug) VALUES (btrim(org_name), candidate)
  RETURNING id INTO new_id;

  INSERT INTO org_members (org_id, person_id, role) VALUES (new_id, person, 'owner');

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
