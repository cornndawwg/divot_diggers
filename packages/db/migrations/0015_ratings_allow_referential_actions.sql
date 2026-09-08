-- 0015  Let an event be deleted, without letting anybody edit a rating.
--
-- player_ratings is append-only, enforced by two DO INSTEAD NOTHING rules. Those rules are
-- blunter than intended: a rule rewrites *every* statement against the table, including the
-- ones Postgres issues itself to honour a foreign key.
--
-- player_ratings.after_event_id is declared ON DELETE SET NULL, so deleting an event makes
-- Postgres issue an UPDATE on player_ratings. The no-update rule turned that into nothing,
-- Postgres saw its own referential query come back wrong, and the whole delete aborted with
--
--   referential integrity query on "events" ... gave unexpected result
--
-- The effect: no event holding rating history could ever be deleted, and neither could an
-- organization, whose cascade is swallowed the same way. A planner who set an event up by
-- mistake was stuck with it permanently, and a group could not be removed on request.
--
-- The fix is to narrow the rules to exactly the case they are for — somebody trying to
-- rewrite history — and let the database's own referential actions through:
--
--   UPDATE  is allowed only when after_event_id is being set to NULL, every other column is
--           untouched, AND the event it pointed at no longer exists. That last clause is
--           what makes it safe: the shape of the statement alone cannot tell the SET NULL
--           apart from somebody typing the same UPDATE by hand, but only the referential
--           action runs after its event is gone.
--   DELETE  is allowed only once the owning organization is already gone, which is true
--           inside a cascade and false for anybody issuing a DELETE by hand.
--
-- The append-only guarantee is unchanged for every caller: values, reasons and history stay
-- unwritable, and the refusal is still silent, as it was before.

DROP RULE IF EXISTS player_ratings_no_update ON player_ratings;
CREATE RULE player_ratings_no_update AS ON UPDATE TO player_ratings
  WHERE NOT (
    OLD.after_event_id IS NOT NULL
    AND NEW.after_event_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.after_event_id)
    AND NEW.id              IS NOT DISTINCT FROM OLD.id
    AND NEW.org_id          IS NOT DISTINCT FROM OLD.org_id
    AND NEW.person_id       IS NOT DISTINCT FROM OLD.person_id
    AND NEW.competition_key IS NOT DISTINCT FROM OLD.competition_key
    AND NEW.raw_value       IS NOT DISTINCT FROM OLD.raw_value
    AND NEW.rounded_value   IS NOT DISTINCT FROM OLD.rounded_value
    AND NEW.reason          IS NOT DISTINCT FROM OLD.reason
    AND NEW.note            IS NOT DISTINCT FROM OLD.note
    AND NEW.created_by      IS NOT DISTINCT FROM OLD.created_by
    AND NEW.created_at      IS NOT DISTINCT FROM OLD.created_at
  )
  DO INSTEAD NOTHING;

DROP RULE IF EXISTS player_ratings_no_delete ON player_ratings;
CREATE RULE player_ratings_no_delete AS ON DELETE TO player_ratings
  WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD.org_id)
  DO INSTEAD NOTHING;
