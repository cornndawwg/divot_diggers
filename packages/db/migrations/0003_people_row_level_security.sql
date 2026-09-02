-- =============================================================================
-- Migration 0003 — Row Level Security on `people`
--
-- FIRST DELIBERATE DIVERGENCE FROM docs/schema.sql.
--
-- 0001 and 0002 are a faithful split of docs/schema.sql and must stay byte-identical
-- to it. This migration is a decided change on top of that baseline, requested after
-- the task 2.2 isolation tests showed that `people` carried no policy: any
-- authenticated connection could read every person's name, email and phone across
-- every tenant.
--
-- `people` stays GLOBAL — one golfer in two groups is still one person with two
-- memberships (spec part 3). Global identity is preserved; global readability is not.
--
-- NOTE ON WRITES: no INSERT policy is granted here. Account creation cannot check
-- `current_person_id()` because the person does not exist yet, so it must run through
-- a privileged path rather than an end-user session. That is an input to task 2.3.
-- =============================================================================

-- Who the current person is allowed to see. SECURITY DEFINER for the same reason
-- is_org_member is: the policy must look at membership rows the caller may not read
-- directly, and a plain function would recurse through RLS.
CREATE OR REPLACE FUNCTION can_read_person(target_person uuid) RETURNS boolean AS $$
  SELECT
    -- Yourself, always.
    target_person = current_person_id()
    -- Anyone who shares an organization with you.
    OR EXISTS (
      SELECT 1
      FROM org_members mine
      JOIN org_members theirs ON theirs.org_id = mine.org_id
      WHERE mine.person_id = current_person_id()
        AND mine.removed_at IS NULL
        AND theirs.person_id = target_person
        AND theirs.removed_at IS NULL
    )
    -- Anyone playing in an event your organization runs. A guest can be added to a
    -- roster without an org membership, and their name still has to render on the
    -- leaderboard for everyone in that org.
    OR EXISTS (
      SELECT 1
      FROM event_players ep
      JOIN events e ON e.id = ep.event_id
      JOIN org_members mine ON mine.org_id = e.org_id
      WHERE ep.person_id = target_person
        AND mine.person_id = current_person_id()
        AND mine.removed_at IS NULL
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

ALTER TABLE people ENABLE ROW LEVEL SECURITY;

CREATE POLICY person_read ON people
  FOR SELECT USING (can_read_person(id));

-- A person may edit their own profile and nobody else's.
CREATE POLICY person_update_self ON people
  FOR UPDATE USING (id = current_person_id())
             WITH CHECK (id = current_person_id());
