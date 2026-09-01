-- =============================================================================
-- Golf Trip App — Database Schema (PostgreSQL)
--
-- Companion to docs/rules-engine-spec.md. Implement in Drizzle as migration 0001.
--
-- Five load-bearing decisions, stated up front because they are hard to reverse:
--
--   1. `people` is global; `org_members` grants access; `event_players` scopes to
--      one event. PTP outlives any single trip, so identity must outlive it too.
--   2. `player_ratings` is append-only. Never UPDATE a rating. The lineage of a
--      player's PTP across years must be reconstructable forever.
--   3. Every event carries a frozen `ruleset_snapshot`. Running and completed
--      events never read the live ruleset, or history silently rewrites itself.
--   4. Derived scoring lives in *_results tables that can be dropped and rebuilt
--      from hole_scores at any time. They are a cache, never a source of truth.
--   5. Every syncable row carries `row_version` from one global sequence. That is
--      what makes cursor-based delta sync possible.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- One global sequence drives sync cursors across every syncable table.
CREATE SEQUENCE row_version_seq AS bigint;

CREATE OR REPLACE FUNCTION touch_row_version() RETURNS trigger AS $$
BEGIN
  NEW.row_version := nextval('row_version_seq');
  NEW.updated_at  := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Set per-request by the API from the authenticated session.
CREATE OR REPLACE FUNCTION current_person_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.person_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- =============================================================================
-- Tenancy and identity
-- =============================================================================

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT nextval('row_version_seq')
);

-- Global identity. A golfer in two groups is ONE person with two memberships
-- and two independent PTP histories. auth_user_id links to Better Auth.
CREATE TABLE people (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  text UNIQUE,
  display_name  text NOT NULL,
  email         citext,
  phone         text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT nextval('row_version_seq')
);

CREATE TABLE org_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','admin','member')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (org_id, person_id)
);
CREATE INDEX ON org_members (person_id) WHERE removed_at IS NULL;


-- =============================================================================
-- Rulesets  (append-only versions; org_id NULL = system preset)
-- =============================================================================

CREATE TABLE rulesets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES organizations(id) ON DELETE CASCADE,
  key           text NOT NULL,
  name          text NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  document      jsonb NOT NULL,
  derived_from  uuid REFERENCES rulesets(id),
  created_by    uuid REFERENCES people(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (org_id, key, version)
);

-- Rulesets are immutable once published. Edits create a new version row.
CREATE OR REPLACE FUNCTION block_published_ruleset_update() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.document IS DISTINCT FROM OLD.document THEN
    RAISE EXCEPTION 'Published ruleset % v% is immutable; create a new version',
      OLD.key, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rulesets_immutable BEFORE UPDATE ON rulesets
  FOR EACH ROW EXECUTE FUNCTION block_published_ruleset_update();


-- =============================================================================
-- Courses  (org_id NULL = shared cross-tenant library)
-- =============================================================================

CREATE TABLE courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  address      text,
  city         text,
  region       text,
  country      text,
  latitude     numeric(9,6),
  longitude    numeric(9,6),
  total_holes  integer NOT NULL DEFAULT 18 CHECK (total_holes > 0),
  verified     boolean NOT NULL DEFAULT false,
  source       text CHECK (source IN ('manual','scorecard_import','library','gps_match')),
  -- A course is PLAYABLE at 'par_only'. Rounds must never block on completeness;
  -- stroke index and yardage can be backfilled later without invalidating scores.
  completeness text NOT NULL DEFAULT 'par_only'
               CHECK (completeness IN ('par_only','full','verified')),
  -- Set when created on the fly; blocks use for scoring until a planner activates.
  pending_review boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES people(id),
  -- PROVENANCE. Commercial course-data licences permit caching but forbid
  -- redistribution, so licensed rows can never feed the shared library and must
  -- be purgeable on termination. Keep the two pools separable by construction.
  provenance   text NOT NULL DEFAULT 'owned'
               CHECK (provenance IN ('owned','licensed')),
  license_provider text,
  external_ref     text,
  licensed_until   date,
  CONSTRAINT licensed_rows_need_provider
    CHECK (provenance = 'owned' OR license_provider IS NOT NULL),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  bigint NOT NULL DEFAULT nextval('row_version_seq')
);

-- Par and stroke index vary BY TEE SET, not by course. Caledonia has four.
CREATE TABLE tee_sets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name           text NOT NULL,
  gender         text NOT NULL DEFAULT 'mens' CHECK (gender IN ('mens','womens','unisex')),
  course_rating  numeric(4,1),
  slope_rating   integer CHECK (slope_rating BETWEEN 55 AND 155),
  par_total      integer,
  yardage_total  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version    bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (course_id, name, gender)
);

CREATE TABLE course_holes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tee_set_id    uuid NOT NULL REFERENCES tee_sets(id) ON DELETE CASCADE,
  hole_number   integer NOT NULL CHECK (hole_number BETWEEN 1 AND 36),
  par           integer NOT NULL CHECK (par BETWEEN 3 AND 6),
  yardage       integer,
  stroke_index  integer CHECK (stroke_index BETWEEN 1 AND 36),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (tee_set_id, hole_number)
);

-- Optional grouping for 27- and 36-hole facilities.
CREATE TABLE course_nines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  hole_numbers integer[] NOT NULL,
  UNIQUE (course_id, name)
);


-- Ad-hoc course capture. The photo is taken offline and queued; extraction runs
-- server-side when signal returns. See rules-engine-spec.md 2.3b.
CREATE TABLE course_import_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES people(id),
  course_id      uuid REFERENCES courses(id) ON DELETE SET NULL,
  -- Images are EPHEMERAL. Deleted on approval/rejection; a bucket lifecycle rule
  -- expires anything abandoned at 48h. Only the extracted JSON is kept.
  image_key        text,                  -- object storage key, never a blob column
  image_bytes      integer,
  image_expires_at timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  image_deleted_at timestamptz,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','needs_review','applied','failed')),
  extracted      jsonb,                   -- raw vision output before validation
  validation     jsonb,                   -- per-check pass/fail from the checksum suite
  all_checks_passed boolean,
  failure_reason text,
  client_uuid    uuid NOT NULL UNIQUE,    -- idempotency: capture may be retried offline
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A terminal job must not still be holding an image.
  CONSTRAINT terminal_jobs_release_image
    CHECK (status NOT IN ('applied','failed') OR image_key IS NULL),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    bigint NOT NULL DEFAULT nextval('row_version_seq')
);
CREATE INDEX ON course_import_jobs (org_id, status, created_at DESC);

-- =============================================================================
-- Events
-- =============================================================================

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  year              integer NOT NULL,
  start_date        date,
  end_date          date,
  join_code         text UNIQUE,
  join_code_expires timestamptz,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','completed','archived')),
  ruleset_id        uuid REFERENCES rulesets(id),
  -- Frozen at start. Running and completed events read THIS, never rulesets.
  ruleset_snapshot  jsonb,
  engine_version    text,
  started_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       bigint NOT NULL DEFAULT nextval('row_version_seq'),
  CONSTRAINT snapshot_required_once_started
    CHECK (status = 'draft' OR ruleset_snapshot IS NOT NULL)
);
CREATE INDEX ON events (org_id, year);

CREATE TABLE event_players (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  handicap_index      numeric(4,1),
  starting_ptp        numeric(10,6) NOT NULL,
  starting_ptp_source text NOT NULL
                      CHECK (starting_ptp_source IN ('carried','seeded_from_handicap',
                                                     'lapsed_adjusted','manual')),
  -- Set when a planner overrides the computed suggestion (the 2021->2022 pattern).
  computed_ptp        numeric(10,6),
  override_reason     text,
  overridden_by       uuid REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (event_id, person_id)
);

-- Roles are per-event. One person can be planner AND captain AND player.
CREATE TABLE event_roles (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('planner','captain','player')),
  UNIQUE (event_id, person_id, role)
);


-- =============================================================================
-- Player ratings — APPEND ONLY. This is the PTP lineage.
-- =============================================================================

CREATE TABLE player_ratings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id         uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  competition_key   text NOT NULL,
  raw_value         numeric(10,6) NOT NULL,   -- full precision, e.g. 14.375
  rounded_value     integer NOT NULL,         -- half-up, e.g. 14
  after_event_id    uuid REFERENCES events(id) ON DELETE SET NULL,
  reason            text NOT NULL
                    CHECK (reason IN ('event_carryover','initial_seed',
                                      'planner_adjustment','lapsed_adjustment','correction')),
  note              text,
  created_by        uuid REFERENCES people(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_ratings (org_id, person_id, competition_key, created_at DESC);

CREATE RULE player_ratings_no_update AS ON UPDATE TO player_ratings DO INSTEAD NOTHING;
CREATE RULE player_ratings_no_delete AS ON DELETE TO player_ratings DO INSTEAD NOTHING;


-- =============================================================================
-- Rounds, tee groups
-- =============================================================================

CREATE TABLE rounds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key             text NOT NULL,              -- matches roundId in the ruleset
  name            text NOT NULL,
  sequence        integer NOT NULL,
  played_on       date,
  course_id       uuid REFERENCES courses(id),
  tee_set_id      uuid REFERENCES tee_sets(id),
  -- {"mode":"all"} | {"mode":"front9"} | {"mode":"custom","holes":[1,2,...]}
  hole_selection  jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  status          text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version     bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (event_id, key)
);

-- A round can feed more than one competition.
CREATE TABLE round_competitions (
  round_id        uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  competition_key text NOT NULL,
  PRIMARY KEY (round_id, competition_key)
);

CREATE TABLE tee_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  tee_time    time,
  sequence    integer NOT NULL,
  locked_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (round_id, sequence)
);

CREATE TABLE tee_group_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tee_group_id    uuid NOT NULL REFERENCES tee_groups(id) ON DELETE CASCADE,
  event_player_id uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  position        integer,
  UNIQUE (tee_group_id, event_player_id)
);


-- =============================================================================
-- Scoring
-- =============================================================================

CREATE TABLE scorecards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  event_player_id uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'not_started'
                  CHECK (status IN ('not_started','in_progress','submitted')),
  did_not_play    boolean NOT NULL DEFAULT false,
  -- 'totals_only' supports backfilling historical rounds with no hole detail.
  entry_mode      text NOT NULL DEFAULT 'hole_by_hole'
                  CHECK (entry_mode IN ('hole_by_hole','totals_only')),
  points_pulled_manual integer,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (round_id, event_player_id),
  CONSTRAINT totals_need_a_total
    CHECK (entry_mode <> 'totals_only' OR did_not_play OR points_pulled_manual IS NOT NULL)
);

CREATE TABLE hole_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id  uuid NOT NULL REFERENCES scorecards(id) ON DELETE CASCADE,
  hole_number   integer NOT NULL CHECK (hole_number BETWEEN 1 AND 36),
  strokes       integer CHECK (strokes > 0),
  picked_up     boolean NOT NULL DEFAULT false,
  capped        boolean NOT NULL DEFAULT false,  -- strokes were capped by pickup policy
  entered_by    uuid NOT NULL REFERENCES people(id),
  client_uuid   uuid NOT NULL UNIQUE,            -- idempotency key for sync
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (scorecard_id, hole_number)
);

-- Accountability: every amendment is visible, not buried in a log.
CREATE TABLE hole_score_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hole_score_id   uuid NOT NULL REFERENCES hole_scores(id) ON DELETE CASCADE,
  previous_strokes integer,
  new_strokes     integer,
  changed_by      uuid NOT NULL REFERENCES people(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hole_score_audit (hole_score_id, changed_at DESC);


-- =============================================================================
-- Derived results — a CACHE. Safe to truncate and rebuild from hole_scores.
-- =============================================================================

CREATE TABLE dogfight_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id          uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  event_player_id   uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  target            numeric(10,6) NOT NULL,
  points_pulled     integer,
  round_delta       numeric(10,6),
  cumulative_delta  numeric(10,6),
  disqualified      boolean NOT NULL DEFAULT false,
  position          integer,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  engine_version    text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version       bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (round_id, event_player_id)
);


-- =============================================================================
-- Ryder Cup
-- =============================================================================

CREATE TABLE cup_teams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key               text NOT NULL,
  name              text NOT NULL,
  colour            text,
  captain_person_id uuid REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version       bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (event_id, key)
);

CREATE TABLE cup_team_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cup_team_id      uuid NOT NULL REFERENCES cup_teams(id) ON DELETE CASCADE,
  event_player_id  uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  draft_pick_number integer,
  drafted_at       timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version      bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (cup_team_id, event_player_id)
);
-- A player can only be drafted by one team per event.
CREATE UNIQUE INDEX cup_one_team_per_player ON cup_team_members (event_player_id);

CREATE TABLE cup_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round_id         uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sequence         integer NOT NULL,
  format           text NOT NULL
                   CHECK (format IN ('scramble','alternate_shot','singles','four_ball')),
  players_per_side integer NOT NULL CHECK (players_per_side > 0),
  matchups_locked_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version      bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (event_id, sequence)
);

CREATE TABLE cup_matches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cup_session_id      uuid NOT NULL REFERENCES cup_sessions(id) ON DELETE CASCADE,
  sequence            integer NOT NULL,
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','in_progress','completed')),
  result              text CHECK (result IN ('team_a','team_b','halved')),
  team_a_id           uuid NOT NULL REFERENCES cup_teams(id),
  team_b_id           uuid NOT NULL REFERENCES cup_teams(id),
  points_a            numeric(4,2),
  points_b            numeric(4,2),
  margin_holes        integer,        -- the "4" in 4&3
  holes_remaining     integer,        -- the "3" in 4&3
  closed_out_at_hole  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version         bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (cup_session_id, sequence),
  CONSTRAINT distinct_teams CHECK (team_a_id <> team_b_id)
);

CREATE TABLE cup_match_players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cup_match_id    uuid NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  cup_team_id     uuid NOT NULL REFERENCES cup_teams(id),
  event_player_id uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  side            text NOT NULL CHECK (side IN ('a','b')),
  UNIQUE (cup_match_id, event_player_id)
);

CREATE TABLE cup_match_holes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cup_match_id    uuid NOT NULL REFERENCES cup_matches(id) ON DELETE CASCADE,
  hole_number     integer NOT NULL CHECK (hole_number BETWEEN 1 AND 36),
  side_a_strokes  integer CHECK (side_a_strokes > 0),
  side_b_strokes  integer CHECK (side_b_strokes > 0),
  -- Conceded holes are genuinely unscored, not scored as zero.
  side_a_conceded boolean NOT NULL DEFAULT false,
  side_b_conceded boolean NOT NULL DEFAULT false,
  winner          text CHECK (winner IN ('a','b','halved')),
  entered_by      uuid NOT NULL REFERENCES people(id),
  client_uuid     uuid NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     bigint NOT NULL DEFAULT nextval('row_version_seq'),
  UNIQUE (cup_match_id, hole_number),
  CONSTRAINT not_both_conceded CHECK (NOT (side_a_conceded AND side_b_conceded))
);


-- =============================================================================
-- Sync ledger — makes replayed mutation batches free
-- =============================================================================

CREATE TABLE sync_mutations (
  client_uuid   uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES people(id),
  event_id      uuid REFERENCES events(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  payload       jsonb NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  result_status text NOT NULL DEFAULT 'applied'
                CHECK (result_status IN ('applied','rejected','superseded'))
);
CREATE INDEX ON sync_mutations (event_id, applied_at DESC);


-- =============================================================================
-- row_version triggers on every syncable table
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','people','org_members','rulesets','courses','tee_sets','course_holes',
    'events','event_players','rounds','tee_groups','scorecards','hole_scores',
    'dogfight_results','cup_teams','cup_team_members','cup_sessions','cup_matches',
    'cup_match_holes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_row_version BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_row_version()', t, t);
  END LOOP;
END $$;


-- Membership helpers. Defined here because SQL function bodies are validated
-- at creation time and these reference tables created above.
CREATE OR REPLACE FUNCTION is_org_member(target_org uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = target_org
      AND m.person_id = current_person_id()
      AND m.removed_at IS NULL
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION has_event_role(target_event uuid, wanted text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM event_roles r
    WHERE r.event_id = target_event
      AND r.person_id = current_person_id()
      AND r.role = wanted
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- =============================================================================
-- Row Level Security
--
-- Enable on EVERY table. The adversarial test (org B cannot read org A) must be
-- written alongside these policies, not afterwards. A missing policy fails
-- silently and is the standard way a multi-tenant app leaks customer data.
--
-- TWO FOOTGUNS, both verified against a live Postgres 16:
--
--   a) A table owner BYPASSES its own RLS policies. The API must connect as a
--      non-owning role (app_user below), or every policy here is decorative.
--      Use FORCE ROW LEVEL SECURITY if the app must run as owner.
--   b) Enabling RLS with no policy denies ALL rows rather than allowing them.
--      That fails closed, which is safe, but presents as "the app shows nothing"
--      rather than as an error. schema-tests.sql asserts this count is zero.
--
--   CREATE ROLE app_user NOLOGIN;
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
--   -- per request:  SET LOCAL app.person_id = '<authenticated person uuid>';
-- =============================================================================

ALTER TABLE organizations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rulesets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_players   ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_roles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_ratings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds          ENABLE ROW LEVEL SECURITY;
ALTER TABLE scorecards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hole_scores     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dogfight_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_teams       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_matches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cup_match_holes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_mutations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_read ON organizations
  FOR SELECT USING (is_org_member(id));

CREATE POLICY member_read ON org_members
  FOR SELECT USING (is_org_member(org_id));

-- System presets (org_id IS NULL) are readable by everyone; org rulesets are not.
CREATE POLICY ruleset_read ON rulesets
  FOR SELECT USING (org_id IS NULL OR is_org_member(org_id));
CREATE POLICY ruleset_write ON rulesets
  FOR ALL USING (org_id IS NOT NULL AND is_org_member(org_id))
           WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id));

-- Shared course library is world-readable; org-private courses are not.
CREATE POLICY course_read ON courses
  FOR SELECT USING (org_id IS NULL OR is_org_member(org_id));

-- Belt and braces: a licensed row may never be promoted to the shared library.
CREATE OR REPLACE FUNCTION block_licensed_in_shared_library() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.provenance = 'licensed' THEN
    RAISE EXCEPTION 'Licensed course data cannot be published to the shared library';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER courses_license_guard BEFORE INSERT OR UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION block_licensed_in_shared_library();

CREATE POLICY event_read ON events
  FOR SELECT USING (is_org_member(org_id));
CREATE POLICY event_write ON events
  FOR ALL USING (has_event_role(id, 'planner'))
           WITH CHECK (has_event_role(id, 'planner'));

CREATE POLICY event_player_read ON event_players
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = event_players.event_id AND is_org_member(e.org_id)));

CREATE POLICY rating_read ON player_ratings
  FOR SELECT USING (is_org_member(org_id));

CREATE POLICY round_read ON rounds
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = rounds.event_id AND is_org_member(e.org_id)));

CREATE POLICY scorecard_read ON scorecards
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
    WHERE r.id = scorecards.round_id AND is_org_member(e.org_id)));

-- Anyone in the same tee group may enter or amend a score. entered_by records who.
CREATE POLICY hole_score_read ON hole_scores
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM scorecards s JOIN rounds r ON r.id = s.round_id
    JOIN events e ON e.id = r.event_id
    WHERE s.id = hole_scores.scorecard_id AND is_org_member(e.org_id)));

CREATE POLICY hole_score_write ON hole_scores
  FOR ALL USING (EXISTS (
    SELECT 1
    FROM scorecards s
    JOIN tee_group_members tgm_target ON tgm_target.event_player_id = s.event_player_id
    JOIN tee_groups tg ON tg.id = tgm_target.tee_group_id AND tg.round_id = s.round_id
    JOIN tee_group_members tgm_self ON tgm_self.tee_group_id = tg.id
    JOIN event_players ep ON ep.id = tgm_self.event_player_id
    WHERE s.id = hole_scores.scorecard_id AND ep.person_id = current_person_id()));

CREATE POLICY sync_own ON sync_mutations
  FOR ALL USING (person_id = current_person_id())
           WITH CHECK (person_id = current_person_id());

-- Cup and results tables: readable by anyone in the owning organization.
CREATE POLICY event_role_read ON event_roles
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = event_roles.event_id AND is_org_member(e.org_id)));

CREATE POLICY dogfight_result_read ON dogfight_results
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM rounds r JOIN events e ON e.id = r.event_id
    WHERE r.id = dogfight_results.round_id AND is_org_member(e.org_id)));

CREATE POLICY cup_team_read ON cup_teams
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM events e WHERE e.id = cup_teams.event_id AND is_org_member(e.org_id)));

CREATE POLICY cup_match_read ON cup_matches
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_sessions cs JOIN events e ON e.id = cs.event_id
    WHERE cs.id = cup_matches.cup_session_id AND is_org_member(e.org_id)));

CREATE POLICY cup_match_hole_read ON cup_match_holes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM cup_matches cm JOIN cup_sessions cs ON cs.id = cm.cup_session_id
    JOIN events e ON e.id = cs.event_id
    WHERE cm.id = cup_match_holes.cup_match_id AND is_org_member(e.org_id)));

-- Players in a match may record its holes.
CREATE POLICY cup_match_hole_write ON cup_match_holes
  FOR ALL USING (EXISTS (
    SELECT 1 FROM cup_match_players cmp
    JOIN event_players ep ON ep.id = cmp.event_player_id
    WHERE cmp.cup_match_id = cup_match_holes.cup_match_id
      AND ep.person_id = current_person_id()));

CREATE POLICY course_import_member ON course_import_jobs
  FOR ALL USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
