-- 0020  What the trip is, what it costs, and who has settled up.
--
-- An event carried a name, a year and some dates. Everything else a group needs to tell its
-- players — where you are staying, what time Thursday starts, what it costs and who to pay —
-- lived in a document somewhere else, which is exactly the thing this app is meant to replace.
--
-- Money is recorded in minor units as integers. A trip costing $1,250.50 is 125050 cents.
-- Floating point is wrong for money in the same way it is wrong for a target, and for the
-- same reason: nobody notices until a total is a penny out and the argument is about the app
-- rather than the golf.
--
-- SCOPE. There is no payment processing here and there never will be: no card details, no
-- gateway, no balances calculated. `event_payments` is a checklist an owner or admin ticks,
-- so they can see at a glance who has handled their business. Settling up still happens
-- between people, off the app.

-- Free text the group writes and players read. Everything that used to be a welcome packet.
ALTER TABLE events ADD COLUMN IF NOT EXISTS welcome_notes text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';

-- The cost breakdown, one line at a time.
CREATE TABLE event_cost_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label       text NOT NULL,
  -- Minor units. Nullable, because "ask Levi" is a legitimate thing for a line to say.
  amount      integer,
  -- True when the amount is what each player pays, false when it is a total for the group.
  per_player  boolean NOT NULL DEFAULT true,
  note        text,
  sequence    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT nextval('row_version_seq')
);
CREATE INDEX event_cost_items_by_event ON event_cost_items (event_id, sequence);

-- Who has settled what. One row per person per thing they might owe.
CREATE TABLE event_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- 'trip' is the cost of being there. 'wager' is what they owe on the golf.
  category    text NOT NULL CHECK (category IN ('trip', 'wager', 'other')),
  paid        boolean NOT NULL DEFAULT false,
  note        text,
  marked_by   uuid REFERENCES people(id) ON DELETE SET NULL,
  marked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (event_id, person_id, category)
);
CREATE INDEX event_payments_by_event ON event_payments (event_id);

ALTER TABLE event_cost_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_payments   ENABLE ROW LEVEL SECURITY;

-- The cost breakdown is for the players. Anyone in the group reads it; only somebody who
-- administers the event writes it.
CREATE POLICY event_cost_read ON event_cost_items
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = event_cost_items.event_id AND is_org_member(e.org_id)));
CREATE POLICY event_cost_write ON event_cost_items
  FOR ALL USING (has_event_role(event_id, 'planner'))
           WITH CHECK (has_event_role(event_id, 'planner'));

-- Who owes what is nobody else's business. A player sees their own row and no one else's;
-- an owner or admin sees the lot, because chasing people is the entire point of the feature.
CREATE POLICY event_payment_read ON event_payments
  FOR SELECT USING (
    person_id = current_person_id() OR has_event_role(event_id, 'planner'));
CREATE POLICY event_payment_write ON event_payments
  FOR ALL USING (has_event_role(event_id, 'planner'))
           WITH CHECK (has_event_role(event_id, 'planner'));
