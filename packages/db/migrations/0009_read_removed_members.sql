-- =============================================================================
-- Migration 0009 — let an owner see who they removed
--
-- Beyond the docs/schema.sql baseline.
--
-- can_read_person (migration 0003) grants a read on anyone sharing an
-- organization, and sharing requires org_members.removed_at IS NULL. Correct by
-- default, but it made a soft-removed golfer invisible to the very owner who
-- removed them — so the "removed" list came back empty and nobody could ever be
-- put back.
--
-- Widened as narrowly as possible: an OWNER OR ADMIN may read someone whose
-- membership of their organization exists at all, removed or not. An ordinary
-- member still cannot, and no other organization can.
-- =============================================================================

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
    )
    -- Anyone you have removed from a group you own, so you can put them back.
    OR EXISTS (
      SELECT 1
      FROM org_members theirs
      WHERE theirs.person_id = target_person
        AND theirs.removed_at IS NOT NULL
        AND is_org_admin(theirs.org_id)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
