-- 0019  Joining an event with a six-character code.
--
-- `join_code` and `join_code_expires` have been columns on `events` since the baseline and
-- nothing has ever read or written them. A player cannot get into the trip on a phone until
-- somebody can hand them a code, so this is the half that has to exist before the app does.
--
-- Two functions, both SECURITY DEFINER for the same reason the other bootstrap functions are:
-- somebody redeeming a code is, by definition, not yet a member of anything, so row level
-- security hides the event from them at the precise moment they need to find it.
--
-- The code is short and typed in by a person standing on a first tee, so it is deliberately
-- weak — six characters from an alphabet with no O/0 or I/1 to misread. Everything that makes
-- that acceptable is here: it expires, it can be rotated or withdrawn at any time, redeeming
-- it grants nothing beyond playing membership, and it is only ever valid for one event.

-- Issue or replace an event's join code. Returns the code so the caller can show it.
CREATE OR REPLACE FUNCTION set_event_join_code(target_event uuid, code text, valid_days integer)
RETURNS text AS $$
DECLARE
  person uuid := current_person_id();
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT has_event_role(target_event, 'planner') THEN
    RAISE EXCEPTION 'Only a group owner or group admin can issue a join code';
  END IF;

  UPDATE events
     SET join_code = code,
         join_code_expires = now() + make_interval(days => valid_days),
         updated_at = now()
   WHERE id = target_event;

  RETURN code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Withdraw it. The event carries on; the code simply stops working.
CREATE OR REPLACE FUNCTION clear_event_join_code(target_event uuid) RETURNS void AS $$
BEGIN
  IF current_person_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT has_event_role(target_event, 'planner') THEN
    RAISE EXCEPTION 'Only a group owner or group admin can withdraw a join code';
  END IF;

  UPDATE events SET join_code = NULL, join_code_expires = NULL, updated_at = now()
   WHERE id = target_event;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Redeem one.
--
-- Makes the caller a member of the group and a player in the event, and nothing more: no
-- roster entry, because being on the roster means a starting target somebody has to decide,
-- and no group role beyond 'member'. A leaked code therefore costs a group a spectator, not
-- an administrator.
--
-- Returns the event id. Redeeming twice is harmless and returns the same answer, so a player
-- who taps it again on a bad signal is not told they have done something wrong.
CREATE OR REPLACE FUNCTION join_event_with_code(code text)
RETURNS uuid AS $$
DECLARE
  person uuid := current_person_id();
  target events%ROWTYPE;
BEGIN
  IF person IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO target FROM events
   WHERE join_code IS NOT NULL AND upper(join_code) = upper(btrim(code));

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'That code does not match an event.';
  END IF;
  IF target.join_code_expires IS NOT NULL AND target.join_code_expires < now() THEN
    RAISE EXCEPTION 'That code has expired. Ask for a new one.';
  END IF;
  IF target.status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'That event has finished.';
  END IF;

  INSERT INTO org_members (org_id, person_id, role) VALUES (target.org_id, person, 'member')
  ON CONFLICT (org_id, person_id) DO UPDATE SET removed_at = NULL, updated_at = now();

  INSERT INTO event_roles (event_id, person_id, role) VALUES (target.id, person, 'player')
  ON CONFLICT DO NOTHING;

  RETURN target.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
