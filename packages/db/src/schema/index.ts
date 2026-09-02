// Drizzle schema for the golf trip database.
//
// PROVENANCE: this file is derived by introspecting a database built from
// ./migrations, which are in turn a faithful split of docs/schema.sql. The SQL
// migrations are the source of truth for the schema; this file exists so queries
// are typed. `pnpm db:verify-schema-types` asserts the two still agree, so a
// migration that changes a column without a matching change here fails a test
// rather than failing at runtime.
//
// Timestamps use mode 'string': timestamptz values come back as ISO strings and
// are handed to the API as-is, rather than round-tripping through a JS Date.
//
// row_version is bigint but mapped to a JS number. One global sequence drives it,
// and exceeding 2^53 would take about nine quadrillion writes.

import { customType, pgTable, foreignKey, unique, pgPolicy, check, uuid, text, integer, jsonb, timestamp, bigint, numeric, boolean, date, index, time, uniqueIndex, primaryKey, pgSequence } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/**
 * Postgres `citext` — case-insensitive text, used for email so two people cannot
 * register the same address in different cases. Drizzle has no built-in mapping.
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});



export const rowVersionSeq = pgSequence("row_version_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const rulesets = pgTable("rulesets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id"),
	key: text().notNull(),
	name: text().notNull(),
	version: integer().notNull(),
	document: jsonb().notNull(),
	derivedFrom: uuid("derived_from"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "rulesets_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.derivedFrom],
			foreignColumns: [table.id],
			name: "rulesets_derived_from_fkey"
		}),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [people.id],
			name: "rulesets_created_by_fkey"
		}),
	unique("rulesets_org_id_key_version_key").on(table.orgId, table.key, table.version),
	pgPolicy("ruleset_write", { as: "permissive", for: "all", to: ["public"], using: sql`((org_id IS NOT NULL) AND is_org_member(org_id))`, withCheck: sql`((org_id IS NOT NULL) AND is_org_member(org_id))`  }),
	pgPolicy("ruleset_read", { as: "permissive", for: "select", to: ["public"] }),
	check("rulesets_version_check", sql`version > 0`),
]);

export const courses = pgTable("courses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id"),
	name: text().notNull(),
	address: text(),
	city: text(),
	region: text(),
	country: text(),
	latitude: numeric({ precision: 9, scale:  6 }),
	longitude: numeric({ precision: 9, scale:  6 }),
	totalHoles: integer("total_holes").default(18).notNull(),
	verified: boolean().default(false).notNull(),
	source: text(),
	completeness: text().default('par_only').notNull(),
	pendingReview: boolean("pending_review").default(false).notNull(),
	createdBy: uuid("created_by"),
	provenance: text().default('owned').notNull(),
	licenseProvider: text("license_provider"),
	externalRef: text("external_ref"),
	licensedUntil: date("licensed_until"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "courses_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [people.id],
			name: "courses_created_by_fkey"
		}),
	pgPolicy("course_read", { as: "permissive", for: "select", to: ["public"], using: sql`((org_id IS NULL) OR is_org_member(org_id))` }),
	check("courses_total_holes_check", sql`total_holes > 0`),
	check("courses_source_check", sql`source = ANY (ARRAY['manual'::text, 'scorecard_import'::text, 'library'::text, 'gps_match'::text])`),
	check("courses_completeness_check", sql`completeness = ANY (ARRAY['par_only'::text, 'full'::text, 'verified'::text])`),
	check("courses_provenance_check", sql`provenance = ANY (ARRAY['owned'::text, 'licensed'::text])`),
	check("licensed_rows_need_provider", sql`(provenance = 'owned'::text) OR (license_provider IS NOT NULL)`),
]);

export const people = pgTable("people", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	authUserId: text("auth_user_id"),
	displayName: text("display_name").notNull(),
	email: citext("email"),
	phone: text(),
	avatarUrl: text("avatar_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	unique("people_auth_user_id_key").on(table.authUserId),
]);

export const courseHoles = pgTable("course_holes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	teeSetId: uuid("tee_set_id").notNull(),
	holeNumber: integer("hole_number").notNull(),
	par: integer().notNull(),
	yardage: integer(),
	strokeIndex: integer("stroke_index"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.teeSetId],
			foreignColumns: [teeSets.id],
			name: "course_holes_tee_set_id_fkey"
		}).onDelete("cascade"),
	unique("course_holes_tee_set_id_hole_number_key").on(table.teeSetId, table.holeNumber),
	check("course_holes_hole_number_check", sql`(hole_number >= 1) AND (hole_number <= 36)`),
	check("course_holes_par_check", sql`(par >= 3) AND (par <= 6)`),
	check("course_holes_stroke_index_check", sql`(stroke_index >= 1) AND (stroke_index <= 36)`),
]);

export const teeSets = pgTable("tee_sets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courseId: uuid("course_id").notNull(),
	name: text().notNull(),
	gender: text().default('mens').notNull(),
	courseRating: numeric("course_rating", { precision: 4, scale:  1 }),
	slopeRating: integer("slope_rating"),
	parTotal: integer("par_total"),
	yardageTotal: integer("yardage_total"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.courseId],
			foreignColumns: [courses.id],
			name: "tee_sets_course_id_fkey"
		}).onDelete("cascade"),
	unique("tee_sets_course_id_name_gender_key").on(table.courseId, table.name, table.gender),
	check("tee_sets_gender_check", sql`gender = ANY (ARRAY['mens'::text, 'womens'::text, 'unisex'::text])`),
	check("tee_sets_slope_rating_check", sql`(slope_rating >= 55) AND (slope_rating <= 155)`),
]);

export const organizations = pgTable("organizations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	unique("organizations_slug_key").on(table.slug),
	pgPolicy("org_read", { as: "permissive", for: "select", to: ["public"], using: sql`is_org_member(id)` }),
]);

export const courseNines = pgTable("course_nines", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courseId: uuid("course_id").notNull(),
	name: text().notNull(),
	holeNumbers: integer("hole_numbers").array().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.courseId],
			foreignColumns: [courses.id],
			name: "course_nines_course_id_fkey"
		}).onDelete("cascade"),
	unique("course_nines_course_id_name_key").on(table.courseId, table.name),
]);

export const orgMembers = pgTable("org_members", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	personId: uuid("person_id").notNull(),
	role: text().notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	index("org_members_person_id_idx").using("btree", table.personId.asc().nullsLast().op("uuid_ops")).where(sql`(removed_at IS NULL)`),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "org_members_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.personId],
			foreignColumns: [people.id],
			name: "org_members_person_id_fkey"
		}).onDelete("cascade"),
	unique("org_members_org_id_person_id_key").on(table.orgId, table.personId),
	pgPolicy("member_read", { as: "permissive", for: "select", to: ["public"], using: sql`is_org_member(org_id)` }),
	check("org_members_role_check", sql`role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])`),
]);

export const events = pgTable("events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	name: text().notNull(),
	year: integer().notNull(),
	startDate: date("start_date"),
	endDate: date("end_date"),
	joinCode: text("join_code"),
	joinCodeExpires: timestamp("join_code_expires", { withTimezone: true, mode: 'string' }),
	status: text().default('draft').notNull(),
	rulesetId: uuid("ruleset_id"),
	rulesetSnapshot: jsonb("ruleset_snapshot"),
	engineVersion: text("engine_version"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	index("events_org_id_year_idx").using("btree", table.orgId.asc().nullsLast().op("int4_ops"), table.year.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "events_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.rulesetId],
			foreignColumns: [rulesets.id],
			name: "events_ruleset_id_fkey"
		}),
	unique("events_join_code_key").on(table.joinCode),
	pgPolicy("event_write", { as: "permissive", for: "all", to: ["public"], using: sql`has_event_role(id, 'planner'::text)`, withCheck: sql`has_event_role(id, 'planner'::text)`  }),
	pgPolicy("event_read", { as: "permissive", for: "select", to: ["public"] }),
	check("events_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'completed'::text, 'archived'::text])`),
	check("snapshot_required_once_started", sql`(status = 'draft'::text) OR (ruleset_snapshot IS NOT NULL)`),
]);

export const courseImportJobs = pgTable("course_import_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	createdBy: uuid("created_by").notNull(),
	courseId: uuid("course_id"),
	imageKey: text("image_key"),
	imageBytes: integer("image_bytes"),
	imageExpiresAt: timestamp("image_expires_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '48:00:00'::interval)`).notNull(),
	imageDeletedAt: timestamp("image_deleted_at", { withTimezone: true, mode: 'string' }),
	status: text().default('queued').notNull(),
	extracted: jsonb(),
	validation: jsonb(),
	allChecksPassed: boolean("all_checks_passed"),
	failureReason: text("failure_reason"),
	clientUuid: uuid("client_uuid").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	index("course_import_jobs_org_id_status_created_at_idx").using("btree", table.orgId.asc().nullsLast().op("timestamptz_ops"), table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "course_import_jobs_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [people.id],
			name: "course_import_jobs_created_by_fkey"
		}),
	foreignKey({
			columns: [table.courseId],
			foreignColumns: [courses.id],
			name: "course_import_jobs_course_id_fkey"
		}).onDelete("set null"),
	unique("course_import_jobs_client_uuid_key").on(table.clientUuid),
	pgPolicy("course_import_member", { as: "permissive", for: "all", to: ["public"], using: sql`is_org_member(org_id)`, withCheck: sql`is_org_member(org_id)`  }),
	check("course_import_jobs_status_check", sql`status = ANY (ARRAY['queued'::text, 'processing'::text, 'needs_review'::text, 'applied'::text, 'failed'::text])`),
	check("terminal_jobs_release_image", sql`(status <> ALL (ARRAY['applied'::text, 'failed'::text])) OR (image_key IS NULL)`),
]);

export const eventPlayers = pgTable("event_players", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	personId: uuid("person_id").notNull(),
	handicapIndex: numeric("handicap_index", { precision: 4, scale:  1 }),
	startingPtp: numeric("starting_ptp", { precision: 10, scale:  6 }).notNull(),
	startingPtpSource: text("starting_ptp_source").notNull(),
	computedPtp: numeric("computed_ptp", { precision: 10, scale:  6 }),
	overrideReason: text("override_reason"),
	overriddenBy: uuid("overridden_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "event_players_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.personId],
			foreignColumns: [people.id],
			name: "event_players_person_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.overriddenBy],
			foreignColumns: [people.id],
			name: "event_players_overridden_by_fkey"
		}),
	unique("event_players_event_id_person_id_key").on(table.eventId, table.personId),
	pgPolicy("event_player_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_players.event_id) AND is_org_member(e.org_id))))` }),
	check("event_players_starting_ptp_source_check", sql`starting_ptp_source = ANY (ARRAY['carried'::text, 'seeded_from_handicap'::text, 'lapsed_adjusted'::text, 'manual'::text])`),
]);

export const eventRoles = pgTable("event_roles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	personId: uuid("person_id").notNull(),
	role: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "event_roles_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.personId],
			foreignColumns: [people.id],
			name: "event_roles_person_id_fkey"
		}).onDelete("cascade"),
	unique("event_roles_event_id_person_id_role_key").on(table.eventId, table.personId, table.role),
	pgPolicy("event_role_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_roles.event_id) AND is_org_member(e.org_id))))` }),
	check("event_roles_role_check", sql`role = ANY (ARRAY['planner'::text, 'captain'::text, 'player'::text])`),
]);

export const teeGroupMembers = pgTable("tee_group_members", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	teeGroupId: uuid("tee_group_id").notNull(),
	eventPlayerId: uuid("event_player_id").notNull(),
	position: integer(),
}, (table) => [
	foreignKey({
			columns: [table.teeGroupId],
			foreignColumns: [teeGroups.id],
			name: "tee_group_members_tee_group_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.eventPlayerId],
			foreignColumns: [eventPlayers.id],
			name: "tee_group_members_event_player_id_fkey"
		}).onDelete("cascade"),
	unique("tee_group_members_tee_group_id_event_player_id_key").on(table.teeGroupId, table.eventPlayerId),
]);

export const scorecards = pgTable("scorecards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	roundId: uuid("round_id").notNull(),
	eventPlayerId: uuid("event_player_id").notNull(),
	status: text().default('not_started').notNull(),
	didNotPlay: boolean("did_not_play").default(false).notNull(),
	entryMode: text("entry_mode").default('hole_by_hole').notNull(),
	pointsPulledManual: integer("points_pulled_manual"),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roundId],
			foreignColumns: [rounds.id],
			name: "scorecards_round_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.eventPlayerId],
			foreignColumns: [eventPlayers.id],
			name: "scorecards_event_player_id_fkey"
		}).onDelete("cascade"),
	unique("scorecards_round_id_event_player_id_key").on(table.roundId, table.eventPlayerId),
	pgPolicy("scorecard_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM (rounds r
     JOIN events e ON ((e.id = r.event_id)))
  WHERE ((r.id = scorecards.round_id) AND is_org_member(e.org_id))))` }),
	check("scorecards_status_check", sql`status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'submitted'::text])`),
	check("scorecards_entry_mode_check", sql`entry_mode = ANY (ARRAY['hole_by_hole'::text, 'totals_only'::text])`),
	check("totals_need_a_total", sql`(entry_mode <> 'totals_only'::text) OR did_not_play OR (points_pulled_manual IS NOT NULL)`),
]);

export const teeGroups = pgTable("tee_groups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	roundId: uuid("round_id").notNull(),
	teeTime: time("tee_time"),
	sequence: integer().notNull(),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roundId],
			foreignColumns: [rounds.id],
			name: "tee_groups_round_id_fkey"
		}).onDelete("cascade"),
	unique("tee_groups_round_id_sequence_key").on(table.roundId, table.sequence),
]);

export const rounds = pgTable("rounds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	key: text().notNull(),
	name: text().notNull(),
	sequence: integer().notNull(),
	playedOn: date("played_on"),
	courseId: uuid("course_id"),
	teeSetId: uuid("tee_set_id"),
	holeSelection: jsonb("hole_selection").default({"mode":"all"}).notNull(),
	status: text().default('scheduled').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "rounds_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.courseId],
			foreignColumns: [courses.id],
			name: "rounds_course_id_fkey"
		}),
	foreignKey({
			columns: [table.teeSetId],
			foreignColumns: [teeSets.id],
			name: "rounds_tee_set_id_fkey"
		}),
	unique("rounds_event_id_key_key").on(table.eventId, table.key),
	pgPolicy("round_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = rounds.event_id) AND is_org_member(e.org_id))))` }),
	check("rounds_status_check", sql`status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])`),
]);

export const playerRatings = pgTable("player_ratings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	personId: uuid("person_id").notNull(),
	competitionKey: text("competition_key").notNull(),
	rawValue: numeric("raw_value", { precision: 10, scale:  6 }).notNull(),
	roundedValue: integer("rounded_value").notNull(),
	afterEventId: uuid("after_event_id"),
	reason: text().notNull(),
	note: text(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("player_ratings_org_id_person_id_competition_key_created_at_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops"), table.personId.asc().nullsLast().op("text_ops"), table.competitionKey.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "player_ratings_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.personId],
			foreignColumns: [people.id],
			name: "player_ratings_person_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.afterEventId],
			foreignColumns: [events.id],
			name: "player_ratings_after_event_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [people.id],
			name: "player_ratings_created_by_fkey"
		}),
	pgPolicy("rating_read", { as: "permissive", for: "select", to: ["public"], using: sql`is_org_member(org_id)` }),
	check("player_ratings_reason_check", sql`reason = ANY (ARRAY['event_carryover'::text, 'initial_seed'::text, 'planner_adjustment'::text, 'lapsed_adjustment'::text, 'correction'::text])`),
]);

export const holeScoreAudit = pgTable("hole_score_audit", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	holeScoreId: uuid("hole_score_id").notNull(),
	previousStrokes: integer("previous_strokes"),
	newStrokes: integer("new_strokes"),
	changedBy: uuid("changed_by").notNull(),
	changedAt: timestamp("changed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("hole_score_audit_hole_score_id_changed_at_idx").using("btree", table.holeScoreId.asc().nullsLast().op("timestamptz_ops"), table.changedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.holeScoreId],
			foreignColumns: [holeScores.id],
			name: "hole_score_audit_hole_score_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.changedBy],
			foreignColumns: [people.id],
			name: "hole_score_audit_changed_by_fkey"
		}),
]);

export const holeScores = pgTable("hole_scores", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scorecardId: uuid("scorecard_id").notNull(),
	holeNumber: integer("hole_number").notNull(),
	strokes: integer(),
	pickedUp: boolean("picked_up").default(false).notNull(),
	capped: boolean().default(false).notNull(),
	enteredBy: uuid("entered_by").notNull(),
	clientUuid: uuid("client_uuid").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.scorecardId],
			foreignColumns: [scorecards.id],
			name: "hole_scores_scorecard_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.enteredBy],
			foreignColumns: [people.id],
			name: "hole_scores_entered_by_fkey"
		}),
	unique("hole_scores_scorecard_id_hole_number_key").on(table.scorecardId, table.holeNumber),
	unique("hole_scores_client_uuid_key").on(table.clientUuid),
	pgPolicy("hole_score_write", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM ((((scorecards s
     JOIN tee_group_members tgm_target ON ((tgm_target.event_player_id = s.event_player_id)))
     JOIN tee_groups tg ON (((tg.id = tgm_target.tee_group_id) AND (tg.round_id = s.round_id))))
     JOIN tee_group_members tgm_self ON ((tgm_self.tee_group_id = tg.id)))
     JOIN event_players ep ON ((ep.id = tgm_self.event_player_id)))
  WHERE ((s.id = hole_scores.scorecard_id) AND (ep.person_id = current_person_id()))))` }),
	pgPolicy("hole_score_read", { as: "permissive", for: "select", to: ["public"] }),
	check("hole_scores_hole_number_check", sql`(hole_number >= 1) AND (hole_number <= 36)`),
	check("hole_scores_strokes_check", sql`strokes > 0`),
]);

export const cupTeams = pgTable("cup_teams", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	key: text().notNull(),
	name: text().notNull(),
	colour: text(),
	captainPersonId: uuid("captain_person_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "cup_teams_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.captainPersonId],
			foreignColumns: [people.id],
			name: "cup_teams_captain_person_id_fkey"
		}),
	unique("cup_teams_event_id_key_key").on(table.eventId, table.key),
	pgPolicy("cup_team_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = cup_teams.event_id) AND is_org_member(e.org_id))))` }),
]);

export const cupTeamMembers = pgTable("cup_team_members", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cupTeamId: uuid("cup_team_id").notNull(),
	eventPlayerId: uuid("event_player_id").notNull(),
	draftPickNumber: integer("draft_pick_number"),
	draftedAt: timestamp("drafted_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	uniqueIndex("cup_one_team_per_player").using("btree", table.eventPlayerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.cupTeamId],
			foreignColumns: [cupTeams.id],
			name: "cup_team_members_cup_team_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.eventPlayerId],
			foreignColumns: [eventPlayers.id],
			name: "cup_team_members_event_player_id_fkey"
		}).onDelete("cascade"),
	unique("cup_team_members_cup_team_id_event_player_id_key").on(table.cupTeamId, table.eventPlayerId),
]);

export const cupSessions = pgTable("cup_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	roundId: uuid("round_id").notNull(),
	sequence: integer().notNull(),
	format: text().notNull(),
	playersPerSide: integer("players_per_side").notNull(),
	matchupsLockedAt: timestamp("matchups_locked_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "cup_sessions_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.roundId],
			foreignColumns: [rounds.id],
			name: "cup_sessions_round_id_fkey"
		}).onDelete("cascade"),
	unique("cup_sessions_event_id_sequence_key").on(table.eventId, table.sequence),
	check("cup_sessions_format_check", sql`format = ANY (ARRAY['scramble'::text, 'alternate_shot'::text, 'singles'::text, 'four_ball'::text])`),
	check("cup_sessions_players_per_side_check", sql`players_per_side > 0`),
]);

export const dogfightResults = pgTable("dogfight_results", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	roundId: uuid("round_id").notNull(),
	eventPlayerId: uuid("event_player_id").notNull(),
	target: numeric({ precision: 10, scale:  6 }).notNull(),
	pointsPulled: integer("points_pulled"),
	roundDelta: numeric("round_delta", { precision: 10, scale:  6 }),
	cumulativeDelta: numeric("cumulative_delta", { precision: 10, scale:  6 }),
	disqualified: boolean().default(false).notNull(),
	position: integer(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	engineVersion: text("engine_version"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roundId],
			foreignColumns: [rounds.id],
			name: "dogfight_results_round_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.eventPlayerId],
			foreignColumns: [eventPlayers.id],
			name: "dogfight_results_event_player_id_fkey"
		}).onDelete("cascade"),
	unique("dogfight_results_round_id_event_player_id_key").on(table.roundId, table.eventPlayerId),
	pgPolicy("dogfight_result_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM (rounds r
     JOIN events e ON ((e.id = r.event_id)))
  WHERE ((r.id = dogfight_results.round_id) AND is_org_member(e.org_id))))` }),
]);

export const cupMatchPlayers = pgTable("cup_match_players", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cupMatchId: uuid("cup_match_id").notNull(),
	cupTeamId: uuid("cup_team_id").notNull(),
	eventPlayerId: uuid("event_player_id").notNull(),
	side: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.cupTeamId],
			foreignColumns: [cupTeams.id],
			name: "cup_match_players_cup_team_id_fkey"
		}),
	foreignKey({
			columns: [table.eventPlayerId],
			foreignColumns: [eventPlayers.id],
			name: "cup_match_players_event_player_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.cupMatchId],
			foreignColumns: [cupMatches.id],
			name: "cup_match_players_cup_match_id_fkey"
		}).onDelete("cascade"),
	unique("cup_match_players_cup_match_id_event_player_id_key").on(table.cupMatchId, table.eventPlayerId),
	check("cup_match_players_side_check", sql`side = ANY (ARRAY['a'::text, 'b'::text])`),
]);

export const syncMutations = pgTable("sync_mutations", {
	clientUuid: uuid("client_uuid").primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	personId: uuid("person_id").notNull(),
	eventId: uuid("event_id"),
	entityType: text("entity_type").notNull(),
	payload: jsonb().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resultStatus: text("result_status").default('applied').notNull(),
}, (table) => [
	index("sync_mutations_event_id_applied_at_idx").using("btree", table.eventId.asc().nullsLast().op("timestamptz_ops"), table.appliedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "sync_mutations_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.personId],
			foreignColumns: [people.id],
			name: "sync_mutations_person_id_fkey"
		}),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "sync_mutations_event_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("sync_own", { as: "permissive", for: "all", to: ["public"], using: sql`(person_id = current_person_id())`, withCheck: sql`(person_id = current_person_id())`  }),
	check("sync_mutations_result_status_check", sql`result_status = ANY (ARRAY['applied'::text, 'rejected'::text, 'superseded'::text])`),
]);

export const cupMatches = pgTable("cup_matches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cupSessionId: uuid("cup_session_id").notNull(),
	sequence: integer().notNull(),
	status: text().default('scheduled').notNull(),
	result: text(),
	teamAId: uuid("team_a_id").notNull(),
	teamBId: uuid("team_b_id").notNull(),
	pointsA: numeric("points_a", { precision: 4, scale:  2 }),
	pointsB: numeric("points_b", { precision: 4, scale:  2 }),
	marginHoles: integer("margin_holes"),
	holesRemaining: integer("holes_remaining"),
	closedOutAtHole: integer("closed_out_at_hole"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.cupSessionId],
			foreignColumns: [cupSessions.id],
			name: "cup_matches_cup_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.teamAId],
			foreignColumns: [cupTeams.id],
			name: "cup_matches_team_a_id_fkey"
		}),
	foreignKey({
			columns: [table.teamBId],
			foreignColumns: [cupTeams.id],
			name: "cup_matches_team_b_id_fkey"
		}),
	unique("cup_matches_cup_session_id_sequence_key").on(table.cupSessionId, table.sequence),
	pgPolicy("cup_match_read", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM (cup_sessions cs
     JOIN events e ON ((e.id = cs.event_id)))
  WHERE ((cs.id = cup_matches.cup_session_id) AND is_org_member(e.org_id))))` }),
	check("cup_matches_status_check", sql`status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'completed'::text])`),
	check("cup_matches_result_check", sql`result = ANY (ARRAY['team_a'::text, 'team_b'::text, 'halved'::text])`),
	check("distinct_teams", sql`team_a_id <> team_b_id`),
]);

export const cupMatchHoles = pgTable("cup_match_holes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cupMatchId: uuid("cup_match_id").notNull(),
	holeNumber: integer("hole_number").notNull(),
	sideAStrokes: integer("side_a_strokes"),
	sideBStrokes: integer("side_b_strokes"),
	sideAConceded: boolean("side_a_conceded").default(false).notNull(),
	sideBConceded: boolean("side_b_conceded").default(false).notNull(),
	winner: text(),
	enteredBy: uuid("entered_by").notNull(),
	clientUuid: uuid("client_uuid").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rowVersion: bigint("row_version", { mode: "number" }).default(sql`nextval('row_version_seq'::regclass)`).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.cupMatchId],
			foreignColumns: [cupMatches.id],
			name: "cup_match_holes_cup_match_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.enteredBy],
			foreignColumns: [people.id],
			name: "cup_match_holes_entered_by_fkey"
		}),
	unique("cup_match_holes_cup_match_id_hole_number_key").on(table.cupMatchId, table.holeNumber),
	unique("cup_match_holes_client_uuid_key").on(table.clientUuid),
	pgPolicy("cup_match_hole_write", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM (cup_match_players cmp
     JOIN event_players ep ON ((ep.id = cmp.event_player_id)))
  WHERE ((cmp.cup_match_id = cup_match_holes.cup_match_id) AND (ep.person_id = current_person_id()))))` }),
	pgPolicy("cup_match_hole_read", { as: "permissive", for: "select", to: ["public"] }),
	check("cup_match_holes_hole_number_check", sql`(hole_number >= 1) AND (hole_number <= 36)`),
	check("cup_match_holes_side_a_strokes_check", sql`side_a_strokes > 0`),
	check("cup_match_holes_side_b_strokes_check", sql`side_b_strokes > 0`),
	check("cup_match_holes_winner_check", sql`winner = ANY (ARRAY['a'::text, 'b'::text, 'halved'::text])`),
	check("not_both_conceded", sql`NOT (side_a_conceded AND side_b_conceded)`),
]);

export const roundCompetitions = pgTable("round_competitions", {
	roundId: uuid("round_id").notNull(),
	competitionKey: text("competition_key").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roundId],
			foreignColumns: [rounds.id],
			name: "round_competitions_round_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.roundId, table.competitionKey], name: "round_competitions_pkey"}),
]);
