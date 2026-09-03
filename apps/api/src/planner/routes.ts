import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  courseDocumentSchema,
  holeSelectionSchema,
  HoleSelectionError,
  resolveHoles,
  parseRuleset,
  validateCourseDocument,
  type CourseNine,
  type IndividualTargetCompetition,
  type Ruleset,
  type Target,
  type TeamMatchPlayCompetition,
} from '@ddga/types';
import type { Auth } from '../auth/auth.ts';
import {
  carriedStartingTarget,
  manualStartingTarget,
  rosterBalance,
  seedFromHandicap,
  suggestLapsedPlayerPtp,
  type StartingTarget,
} from '@ddga/scoring-engine';
import { CourseImportRejected, importCourse } from '../courses/import.ts';

export interface PlannerDeps {
  readonly auth: Auth;
  readonly privilegedPool: Pool;
  readonly domainPool: Pool;
}

/** A slug a human would recognise, derived from the group's name. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base === '' ? `group-${Date.now().toString(36)}` : base;
}

/**
 * Postgres raises 42501 when a row level security policy refuses a write. That is an
 * authorization outcome, not a server fault, so it must not surface as a 500 — the
 * difference matters both to the console and to anyone reading logs for real breakage.
 */
function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42501'
  );
}

/** Postgres 23505: a unique constraint. A conflict, not a fault. */
function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Raised by the SECURITY DEFINER bootstrap functions when the caller is not entitled. */
function isRefusedByFunction(error: unknown): boolean {
  return (
    error instanceof Error &&
    /not a member of that organization|Not signed in, so there is nobody/i.test(error.message)
  );
}

export function plannerRoutes(deps: PlannerDeps): Hono {
  const { auth, privilegedPool, domainPool } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    if (isPermissionDenied(error) || isRefusedByFunction(error)) {
      return c.json({ error: 'You do not have permission to do that.' }, 403);
    }
    if (error instanceof HoleSelectionError) {
      return c.json({ error: error.message }, 422);
    }
    if (isConflict(error)) {
      return c.json({ error: 'That already exists.' }, 409);
    }
    console.error(error);
    return c.json({ error: 'Something went wrong.' }, 500);
  });

  /**
   * Resolve the signed-in golfer, then run the work as them so RLS applies.
   * The identity lookup is privileged and the work is not — see the note in app.ts.
   */
  async function asSignedIn<T>(
    headers: Headers,
    work: (client: PoolClient, personId: string) => Promise<T>,
  ): Promise<{ status: 401 } | { status: 200; value: T }> {
    const session = await auth.api.getSession({ headers });
    if (session === null) return { status: 401 };

    const person = await privilegedPool.query<{ id: string }>(
      'SELECT id FROM people WHERE auth_user_id = $1',
      [session.user.id],
    );
    const personId = person.rows[0]?.id;
    if (personId === undefined) return { status: 401 };

    const client = await domainPool.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.person_id', personId]);
      return { status: 200, value: await work(client, personId) };
    } finally {
      await client.query('SELECT set_config($1, $2, false)', ['app.person_id', '']);
      client.release();
    }
  }

  app.get('/api/organizations', async (c) => {
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{ id: string; name: string; slug: string }>(
        'SELECT id, name, slug FROM organizations ORDER BY name',
      );
      return rows;
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ organizations: result.value });
  });

  app.post('/api/organizations', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return c.json({ error: 'A group needs a name.' }, 400);

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      // A function, not a plain insert: it creates the group and the owner membership
      // together, so there is never a group nobody can reach.
      const { rows } = await client.query<{ create_organization: string }>(
        'SELECT create_organization($1, $2)',
        [name, slugify(name)],
      );
      return rows[0]?.create_organization ?? null;
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ id: result.value, name }, 201);
  });

  app.get('/api/courses', async (c) => {
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        total_holes: number;
        completeness: string;
        tee_sets: number;
      }>(
        `SELECT c.id, c.name, c.total_holes, c.completeness,
                (SELECT count(*)::int FROM tee_sets t WHERE t.course_id = c.id) AS tee_sets
           FROM courses c ORDER BY c.name`,
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        totalHoles: row.total_holes,
        completeness: row.completeness,
        teeSets: row.tee_sets,
      }));
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ courses: result.value });
  });

  app.post('/api/courses', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = courseDocumentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'That is not a course.',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
      );
    }

    const validation = validateCourseDocument(parsed.data);

    const result = await asSignedIn(c.req.raw.headers, async (client, personId) => {
      const org = await client.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
      const orgId = org.rows[0]?.id;
      if (orgId === undefined) return { kind: 'no-org' as const };

      try {
        await client.query('BEGIN');
        const outcome = await importCourse(client, orgId, personId, parsed.data);
        await client.query('COMMIT');
        return { kind: 'created' as const, outcome };
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof CourseImportRejected) {
          return { kind: 'rejected' as const, validation: error.validation };
        }
        throw error;
      }
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-org') return c.json({ error: 'Create your group first.' }, 409);
    if (result.value.kind === 'rejected') {
      return c.json(
        { error: 'The scorecard does not add up.', validation: result.value.validation },
        422,
      );
    }
    return c.json(
      {
        id: result.value.outcome.courseId,
        teeSetIds: result.value.outcome.teeSetIds,
        holeCount: result.value.outcome.holeCount,
        validation,
      },
      201,
    );
  });

  app.get('/api/events', async (c) => {
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        year: number;
        status: string;
        rounds: number;
      }>(
        `SELECT e.id, e.name, e.year, e.status,
                (SELECT count(*)::int FROM rounds r WHERE r.event_id = e.id) AS rounds
           FROM events e ORDER BY e.year DESC, e.name`,
      );
      return rows;
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ events: result.value });
  });

  app.post('/api/events', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      organizationId?: unknown;
      name?: unknown;
      year?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const year = typeof body.year === 'number' ? body.year : new Date().getUTCFullYear();
    if (name === '') return c.json({ error: 'An event needs a name.' }, 400);

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      let orgId = typeof body.organizationId === 'string' ? body.organizationId : undefined;
      if (orgId === undefined) {
        const org = await client.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
        orgId = org.rows[0]?.id;
      }
      if (orgId === undefined) return { kind: 'no-org' as const };

      const { rows } = await client.query<{ create_event: string }>(
        'SELECT create_event($1, $2, $3)',
        [orgId, name, year],
      );
      const id = rows[0]?.create_event ?? null;

      // Point the event at the group's newest ruleset so scoring has config to read. The
      // snapshot is taken separately, when the event starts.
      if (id !== null) {
        await client.query(
          `UPDATE events SET ruleset_id = (
             SELECT r.id FROM rulesets r
              WHERE r.org_id = $2 AND r.published_at IS NOT NULL
              ORDER BY r.version DESC LIMIT 1)
           WHERE id = $1`,
          [id, orgId],
        );
      }
      return { kind: 'created' as const, id };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-org') return c.json({ error: 'Create your group first.' }, 409);
    return c.json({ id: result.value.id, name, year }, 201);
  });

  /**
   * The ruleset an event scores by.
   *
   * A running or completed event reads its frozen snapshot, never the live ruleset —
   * invariant #6. Without that, editing a point value in 2029 silently rewrites 2027's
   * results. A draft event has no snapshot yet, so it reads the version it points at.
   */
  async function rulesetFor(client: PoolClient, eventId: string): Promise<Ruleset | null> {
    const { rows } = await client.query<{
      status: string;
      snapshot: unknown;
      document: unknown;
    }>(
      `SELECT e.status, e.ruleset_snapshot AS snapshot, r.document
         FROM events e LEFT JOIN rulesets r ON r.id = e.ruleset_id
        WHERE e.id = $1`,
      [eventId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const source = row.snapshot ?? (row.status === 'draft' ? row.document : null);
    if (source === null || source === undefined) return null;
    try {
      return parseRuleset(source);
    } catch {
      return null;
    }
  }

  async function targetConfigFor(client: PoolClient, eventId: string): Promise<Target | null> {
    const ruleset = await rulesetFor(client, eventId);
    const competition = ruleset?.competitions.find(
      (entry): entry is IndividualTargetCompetition => entry.type === 'individual_target',
    );
    return competition?.target ?? null;
  }

  async function cupConfigFor(
    client: PoolClient,
    eventId: string,
  ): Promise<TeamMatchPlayCompetition | null> {
    const ruleset = await rulesetFor(client, eventId);
    return (
      ruleset?.competitions.find(
        (entry): entry is TeamMatchPlayCompetition => entry.type === 'team_match_play',
      ) ?? null
    );
  }

  // --- rulesets -------------------------------------------------------------

  app.get('/api/rulesets', async (c) => {
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{
        id: string;
        key: string;
        name: string;
        version: number;
        org_id: string | null;
      }>('SELECT id, key, name, version, org_id FROM rulesets ORDER BY key, version DESC');
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        version: row.version,
        isSystemPreset: row.org_id === null,
      }));
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ rulesets: result.value });
  });

  /**
   * Store a ruleset document. Append-only: editing publishes a new version and the old one is
   * never mutated, because a completed event's snapshot has to stay meaningful.
   */
  app.post('/api/rulesets', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    let ruleset: Ruleset;
    try {
      ruleset = parseRuleset(body);
    } catch (error) {
      return c.json(
        {
          error: 'That ruleset is not valid.',
          detail: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }

    const result = await asSignedIn(c.req.raw.headers, async (client, personId) => {
      const org = await client.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
      const orgId = org.rows[0]?.id;
      if (orgId === undefined) return { kind: 'no-org' as const };

      const next = await client.query<{ next: number }>(
        'SELECT coalesce(max(version), 0) + 1 AS next FROM rulesets WHERE org_id = $1 AND key = $2',
        [orgId, ruleset.rulesetId],
      );
      const version = next.rows[0]?.next ?? 1;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO rulesets (org_id, key, name, version, document, created_by, published_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [orgId, ruleset.rulesetId, ruleset.name, version, JSON.stringify(body), personId],
      );
      return { kind: 'created' as const, id: rows[0]?.id ?? null, version };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-org') return c.json({ error: 'Create your group first.' }, 409);
    return c.json({ id: result.value.id, key: ruleset.rulesetId, version: result.value.version }, 201);
  });

  /** Load a tee set's holes and resolve the selection against them. */
  async function resolveRound(
    client: PoolClient,
    teeSetId: string,
    selection: Parameters<typeof resolveHoles>[1],
  ) {
    const teeSet = await client.query<{ name: string; course_id: string }>(
      'SELECT name, course_id FROM tee_sets WHERE id = $1',
      [teeSetId],
    );
    const found = teeSet.rows[0];
    if (found === undefined) return null;

    const holes = await client.query<{
      hole_number: number;
      par: number;
      yardage: number | null;
      stroke_index: number | null;
    }>(
      'SELECT hole_number, par, yardage, stroke_index FROM course_holes WHERE tee_set_id = $1',
      [teeSetId],
    );
    if (holes.rows.length === 0) return null;

    const nines = await client.query<{ id: string; name: string; hole_numbers: number[] }>(
      'SELECT id, name, hole_numbers FROM course_nines WHERE course_id = $1',
      [found.course_id],
    );

    return resolveHoles(
      {
        name: found.name,
        holes: holes.rows.map((row) => ({
          holeNumber: row.hole_number,
          par: row.par,
          yardage: row.yardage,
          strokeIndex: row.stroke_index,
        })),
      },
      selection,
      nines.rows.map<CourseNine>((row) => ({
        id: row.id,
        name: row.name,
        holeNumbers: row.hole_numbers,
      })),
    );
  }

  // --- the player archive -------------------------------------------------
  //
  // Everyone this group has ever put on a roster, so next year's is picked rather than
  // retyped. Contact details ride along because chasing confirmations is the planner's
  // actual job in the weeks before a trip.

  app.get('/api/people', async (c) => {
    // An empty ?eventId= must not reach a uuid cast.
    const raw = c.req.query('eventId');
    const eventId = raw === undefined || raw.trim() === '' ? null : raw.trim();
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{
        id: string;
        display_name: string;
        email: string | null;
        phone: string | null;
        last_year: number | null;
        events_played: number;
        last_rating_raw: string | null;
        last_rating_rounded: number | null;
        last_rating_year: number | null;
        on_roster: boolean;
      }>(
        `SELECT p.id, p.display_name, p.email, p.phone,
                appearances.last_year,
                coalesce(appearances.events_played, 0)::int AS events_played,
                rating.raw_value      AS last_rating_raw,
                rating.rounded_value  AS last_rating_rounded,
                rating.year           AS last_rating_year,
                $1::uuid IS NOT NULL AND EXISTS (
                  SELECT 1 FROM event_players ep
                   WHERE ep.person_id = p.id AND ep.event_id = $1::uuid
                ) AS on_roster
           FROM people p
           JOIN org_members m ON m.person_id = p.id
                             AND (($2::boolean) OR m.removed_at IS NULL)
                             AND ((NOT $2::boolean) OR m.removed_at IS NOT NULL)
           LEFT JOIN LATERAL (
             SELECT max(e.year) AS last_year, count(*) AS events_played
               FROM event_players ep JOIN events e ON e.id = ep.event_id
              WHERE ep.person_id = p.id
           ) appearances ON true
           LEFT JOIN LATERAL (
             SELECT r.raw_value, r.rounded_value, e.year
               FROM player_ratings r
               LEFT JOIN events e ON e.id = r.after_event_id
              WHERE r.person_id = p.id
              ORDER BY r.created_at DESC
              LIMIT 1
           ) rating ON true
          ORDER BY p.display_name`,
        [eventId, c.req.query('removed') === 'true'],
      );

      return rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        email: row.email,
        phone: row.phone,
        lastYear: row.last_year,
        eventsPlayed: row.events_played,
        lastRating:
          row.last_rating_rounded === null
            ? null
            : {
                raw: Number(row.last_rating_raw),
                rounded: row.last_rating_rounded,
                year: row.last_rating_year,
              },
        onRoster: row.on_roster,
      }));
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ people: result.value });
  });

  app.post('/api/people', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      email?: unknown;
      phone?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return c.json({ error: 'A golfer needs a name.' }, 400);

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const org = await client.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
      const orgId = org.rows[0]?.id;
      if (orgId === undefined) return { kind: 'no-org' as const };

      const { rows } = await client.query<{ add_org_person: string }>(
        'SELECT add_org_person($1, $2, $3, $4)',
        [
          orgId,
          name,
          typeof body.email === 'string' && body.email.trim() !== '' ? body.email.trim() : null,
          typeof body.phone === 'string' && body.phone.trim() !== '' ? body.phone.trim() : null,
        ],
      );
      return { kind: 'created' as const, id: rows[0]?.add_org_person ?? null };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-org') return c.json({ error: 'Create your group first.' }, 409);
    return c.json({ id: result.value.id, name }, 201);
  });

  app.get('/api/events/:id/rounds', async (c) => {
    const eventId = c.req.param('id');
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const { rows } = await client.query<{ id: string; name: string; sequence: number }>(
        'SELECT id, name, sequence FROM rounds WHERE event_id = $1 ORDER BY sequence',
        [eventId],
      );
      return rows;
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json({ rounds: result.value });
  });

  app.get('/api/rounds/:id', async (c) => {
    const id = c.req.param('id');
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const round = await client.query<{
        id: string;
        name: string;
        key: string;
        status: string;
        hole_selection: unknown;
        tee_set_id: string | null;
        course_name: string | null;
        tee_set_name: string | null;
      }>(
        `SELECT r.id, r.name, r.key, r.status, r.hole_selection, r.tee_set_id,
                c.name AS course_name, t.name AS tee_set_name
           FROM rounds r
           LEFT JOIN courses c ON c.id = r.course_id
           LEFT JOIN tee_sets t ON t.id = r.tee_set_id
          WHERE r.id = $1`,
        [id],
      );
      const found = round.rows[0];
      if (found === undefined) return null;

      const selection = holeSelectionSchema.safeParse(found.hole_selection);
      if (!selection.success || found.tee_set_id === null) {
        return {
          id: found.id,
          name: found.name,
          key: found.key,
          status: found.status,
          course: found.course_name,
          teeSet: found.tee_set_name,
          holeSelection: found.hole_selection,
          resolved: null,
        };
      }

      const resolved = await resolveRound(client, found.tee_set_id, selection.data);
      return {
        id: found.id,
        name: found.name,
        key: found.key,
        status: found.status,
        course: found.course_name,
        teeSet: found.tee_set_name,
        holeSelection: selection.data,
        resolved,
      };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value === null) return c.json({ error: 'No such round.' }, 404);
    return c.json(result.value);
  });

  // --- rosters --------------------------------------------------------------

  app.get('/api/events/:id/players', async (c) => {
    const eventId = c.req.param('id');
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const players = await client.query<{
        id: string;
        person_id: string;
        display_name: string;
        email: string | null;
        phone: string | null;
        handicap_index: string | null;
        starting_ptp: string;
        starting_ptp_source: string;
        computed_ptp: string | null;
        override_reason: string | null;
      }>(
        `SELECT ep.id, ep.person_id, p.display_name, p.email, p.phone,
                ep.handicap_index, ep.starting_ptp, ep.starting_ptp_source,
                ep.computed_ptp, ep.override_reason
           FROM event_players ep JOIN people p ON p.id = ep.person_id
          WHERE ep.event_id = $1
          ORDER BY p.display_name`,
        [eventId],
      );

      const event = await client.query<{ org_id: string; ruleset_snapshot: unknown }>(
        'SELECT org_id, ruleset_snapshot FROM events WHERE id = $1',
        [eventId],
      );

      return {
        players: players.rows.map((row) => ({
          id: row.id,
          personId: row.person_id,
          displayName: row.display_name,
          email: row.email,
          phone: row.phone,
          handicapIndex: row.handicap_index === null ? null : Number(row.handicap_index),
          startingPtp: Number(row.starting_ptp),
          startingPtpSource: row.starting_ptp_source,
          computedPtp: row.computed_ptp === null ? null : Number(row.computed_ptp),
          overrideReason: row.override_reason,
        })),
        organizationId: event.rows[0]?.org_id ?? null,
      };
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    return c.json(result.value);
  });

  /**
   * Put a golfer on the roster with a starting target.
   *
   * The source is chosen, not guessed: a carried value, a seed from a handicap index, a
   * handicap-delta suggestion for someone returning after a gap, or a number the planner
   * typed. Whichever it is, the archive records which — and when the planner overrides a
   * computed value, both numbers are kept, because that override pattern is real and it is
   * how the 2021 to 2022 transitions actually happened.
   */
  app.post('/api/events/:id/players', async (c) => {
    const eventId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      personId?: unknown;
      handicapIndex?: unknown;
      startingPtp?: unknown;
      source?: unknown;
      overrideReason?: unknown;
    };
    const personId = typeof body.personId === 'string' ? body.personId : '';
    if (personId === '') return c.json({ error: 'Choose a golfer first.' }, 400);

    const handicapIndex =
      typeof body.handicapIndex === 'number' && Number.isFinite(body.handicapIndex)
        ? body.handicapIndex
        : null;
    const manualPtp =
      typeof body.startingPtp === 'number' && Number.isFinite(body.startingPtp)
        ? body.startingPtp
        : null;

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const target = await targetConfigFor(client, eventId);
      if (target === null) return { kind: 'no-target' as const };

      const priorRating = await client.query<{ raw_value: string }>(
        `SELECT r.raw_value FROM player_ratings r
           JOIN events e ON e.id = $1
          WHERE r.person_id = $2 AND r.org_id = e.org_id
          ORDER BY r.created_at DESC LIMIT 1`,
        [eventId, personId],
      );
      const carriedRaw =
        priorRating.rows[0] === undefined ? null : Number(priorRating.rows[0].raw_value);

      let seeded: StartingTarget;
      const requested = typeof body.source === 'string' ? body.source : undefined;

      if (requested === 'manual' && manualPtp !== null) {
        seeded = manualStartingTarget(
          manualPtp,
          typeof body.overrideReason === 'string' ? body.overrideReason : undefined,
        );
      } else if (requested === 'seeded_from_handicap' && handicapIndex !== null) {
        seeded = seedFromHandicap(handicapIndex, target);
      } else if (carriedRaw !== null) {
        seeded = carriedStartingTarget(carriedRaw, target);
      } else if (handicapIndex !== null) {
        seeded = seedFromHandicap(handicapIndex, target);
      } else if (manualPtp !== null) {
        seeded = manualStartingTarget(manualPtp);
      } else {
        return { kind: 'nothing-to-seed-from' as const };
      }

      // Keep the computed value alongside an override, so the archive can explain both.
      const computed =
        requested === 'manual' && carriedRaw !== null
          ? carriedStartingTarget(carriedRaw, target).value
          : null;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO event_players
           (event_id, person_id, handicap_index, starting_ptp, starting_ptp_source,
            computed_ptp, override_reason, overridden_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (event_id, person_id) DO UPDATE
           SET handicap_index = excluded.handicap_index,
               starting_ptp = excluded.starting_ptp,
               starting_ptp_source = excluded.starting_ptp_source,
               computed_ptp = excluded.computed_ptp,
               override_reason = excluded.override_reason
         RETURNING id`,
        [
          eventId,
          personId,
          handicapIndex,
          seeded.value,
          seeded.source,
          computed,
          typeof body.overrideReason === 'string' && body.overrideReason !== ''
            ? body.overrideReason
            : null,
          null,
        ],
      );

      // Everyone on a roster is a player in that event.
      await client.query(
        `INSERT INTO event_roles (event_id, person_id, role) VALUES ($1,$2,'player')
         ON CONFLICT (event_id, person_id, role) DO NOTHING`,
        [eventId, personId],
      );

      return { kind: 'added' as const, id: rows[0]?.id ?? null, seeded };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-target') {
      return c.json({ error: 'This event has no dogfight competition configured.' }, 409);
    }
    if (result.value.kind === 'nothing-to-seed-from') {
      return c.json(
        {
          error:
            'This golfer has no carried rating, so a handicap index or a starting target is needed.',
        },
        422,
      );
    }
    return c.json({ id: result.value.id, startingTarget: result.value.seeded }, 201);
  });

  /**
   * Take someone off this year's roster.
   *
   * Refused once they have been scored: scorecards cascade from event_players, so the delete
   * would take their scores with it. The database enforces that with a trigger, and this
   * turns the refusal into something a planner can read.
   */
  app.delete('/api/events/:id/players/:personId', async (c) => {
    const eventId = c.req.param('id');
    const personId = c.req.param('personId');

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      try {
        const removed = await client.query(
          'DELETE FROM event_players WHERE event_id = $1 AND person_id = $2',
          [eventId, personId],
        );
        if (removed.rowCount === 0) return { kind: 'not-on-roster' as const };
        // They keep any other role, but they are no longer a player in this event.
        await client.query(
          `DELETE FROM event_roles WHERE event_id = $1 AND person_id = $2 AND role = 'player'`,
          [eventId, personId],
        );
        return { kind: 'removed' as const };
      } catch (error) {
        if (error instanceof Error && /already has scores recorded/i.test(error.message)) {
          return { kind: 'has-scores' as const, message: error.message };
        }
        throw error;
      }
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'not-on-roster') {
      return c.json({ error: 'They are not on this roster.' }, 404);
    }
    if (result.value.kind === 'has-scores') {
      return c.json({ error: result.value.message }, 409);
    }
    return c.json({ removed: true });
  });

  /**
   * Remove someone from the group's archive.
   *
   * Soft: their rating history is the PTP lineage and has to stay reconstructable, so it is
   * never deleted. They disappear from the picker; putting them back restores everything.
   */
  app.delete('/api/people/:personId', async (c) => {
    const personId = c.req.param('personId');
    const result = await asSignedIn(c.req.raw.headers, async (client, self) => {
      if (personId === self) return { kind: 'self' as const };
      const updated = await client.query(
        `UPDATE org_members SET removed_at = now()
          WHERE person_id = $1 AND removed_at IS NULL`,
        [personId],
      );
      return updated.rowCount === 0
        ? ({ kind: 'not-found' as const })
        : ({ kind: 'removed' as const });
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'self') {
      return c.json({ error: 'You cannot remove yourself from your own group.' }, 409);
    }
    if (result.value.kind === 'not-found') {
      return c.json({ error: 'Nobody to remove, or you are not an owner of this group.' }, 404);
    }
    return c.json({ removed: true });
  });

  /** Put someone back, with their rating history intact. */
  app.post('/api/people/:personId/restore', async (c) => {
    const personId = c.req.param('personId');
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const updated = await client.query(
        `UPDATE org_members SET removed_at = NULL
          WHERE person_id = $1 AND removed_at IS NOT NULL`,
        [personId],
      );
      return updated.rowCount === 0 ? 'not-found' : 'restored';
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value === 'not-found') {
      return c.json({ error: 'Nobody to put back, or you are not an owner of this group.' }, 404);
    }
    return c.json({ restored: true });
  });

  /** What a returning golfer's target might be, for the planner to confirm or edit. */
  app.get('/api/events/:id/players/:personId/suggestion', async (c) => {
    const eventId = c.req.param('id');
    const personId = c.req.param('personId');
    const currentIndex = Number(c.req.query('handicapIndex'));

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const target = await targetConfigFor(client, eventId);
      if (target === null) return null;

      const last = await client.query<{
        raw_value: string;
        handicap_index: string | null;
        year: number | null;
      }>(
        `SELECT r.raw_value, ep.handicap_index, e.year
           FROM player_ratings r
           LEFT JOIN events e ON e.id = r.after_event_id
           LEFT JOIN event_players ep ON ep.event_id = e.id AND ep.person_id = r.person_id
          WHERE r.person_id = $1
          ORDER BY r.created_at DESC LIMIT 1`,
        [personId],
      );
      const row = last.rows[0];
      if (row === undefined) return null;

      const event = await client.query<{ year: number }>('SELECT year FROM events WHERE id = $1', [
        eventId,
      ]);
      const gap =
        row.year === null ? 1 : Math.max(1, (event.rows[0]?.year ?? row.year) - row.year - 1);

      return suggestLapsedPlayerPtp(
        {
          lastPtp: Number(row.raw_value),
          handicapIndexAtLastAppearance:
            row.handicap_index === null ? currentIndex : Number(row.handicap_index),
          currentHandicapIndex: Number.isFinite(currentIndex) ? currentIndex : 0,
          eventsMissed: gap,
        },
        target,
      );
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value === null) {
      return c.json({ error: 'No prior rating on file for this golfer.' }, 404);
    }
    return c.json(result.value);
  });

  /** Whether this roster can actually field the cup the ruleset describes. */
  app.get('/api/events/:id/roster-balance', async (c) => {
    const eventId = c.req.param('id');
    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM event_players WHERE event_id = $1',
        [eventId],
      );
      const cup = await cupConfigFor(client, eventId);
      if (cup === null) return null;
      return rosterBalance(Number(count.rows[0]?.count ?? 0), cup);
    });
    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value === null) {
      return c.json({ error: 'This event has no cup competition configured.' }, 409);
    }
    return c.json(result.value);
  });

  app.post('/api/rounds', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      eventId?: unknown;
      courseId?: unknown;
      teeSetId?: unknown;
      name?: unknown;
      holeSelection?: unknown;
    };
    const eventId = typeof body.eventId === 'string' ? body.eventId : '';
    const courseId = typeof body.courseId === 'string' ? body.courseId : '';
    if (eventId === '' || courseId === '') {
      return c.json({ error: 'A round needs an event and a course.' }, 400);
    }
    const name =
      typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : 'Round';

    const selection = holeSelectionSchema.safeParse(body.holeSelection ?? { mode: 'all' });
    if (!selection.success) {
      return c.json(
        {
          error: 'That is not a hole selection.',
          issues: selection.error.issues.map((issue) => issue.message),
        },
        400,
      );
    }
    const holeSelection = selection.data;

    const result = await asSignedIn(c.req.raw.headers, async (client) => {
      const teeSetId =
        typeof body.teeSetId === 'string' && body.teeSetId !== ''
          ? body.teeSetId
          : ((
              await client.query<{ id: string }>(
                'SELECT id FROM tee_sets WHERE course_id = $1 ORDER BY yardage_total DESC NULLS LAST LIMIT 1',
                [courseId],
              )
            ).rows[0]?.id ?? null);

      // Resolve before writing. A round that cannot produce a hole list is not a round,
      // and finding that out on the first tee is far worse than finding it out here.
      if (teeSetId !== null) {
        const resolved = await resolveRound(client, teeSetId, holeSelection);
        if (resolved === null) {
          throw new HoleSelectionError('That tee set has no holes entered yet.');
        }
      }

      const next = await client.query<{ next: number }>(
        'SELECT coalesce(max(sequence), 0) + 1 AS next FROM rounds WHERE event_id = $1',
        [eventId],
      );
      const sequence = next.rows[0]?.next ?? 1;

      const { rows } = await client.query<{ id: string; key: string }>(
        `INSERT INTO rounds (event_id, key, name, sequence, course_id, tee_set_id, hole_selection, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress')
         RETURNING id, key`,
        [
          eventId,
          `round-${sequence}`,
          name,
          sequence,
          courseId,
          teeSetId,
          JSON.stringify(holeSelection),
        ],
      );
      return rows[0] ?? null;
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value === null) return c.json({ error: 'Could not start the round.' }, 400);
    return c.json(result.value, 201);
  });

  return app;
}
