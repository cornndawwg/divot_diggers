-- =============================================================================
-- Migration 0001 — tables, indexes and constraints
--
-- Ported from docs/schema.sql, which is the authority. Statements were split by
-- category, never rewritten: docs/schema.sql and these migrations must produce
-- identical schemas. Verify with `pnpm db:verify-migration`.
--
-- Functions, triggers, rules and RLS policies live in 0002 because Drizzle does
-- not model them.
-- =============================================================================

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
