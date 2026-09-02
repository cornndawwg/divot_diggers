import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import {
  courseDocumentSchema,
  holeSelectionSchema,
  HoleSelectionError,
  resolveHoles,
  validateCourseDocument,
  type CourseNine,
} from '@ddga/types';
import type { Auth } from '../auth/auth.ts';
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
      return { kind: 'created' as const, id: rows[0]?.create_event ?? null };
    });

    if (result.status === 401) return c.json({ error: 'Not signed in.' }, 401);
    if (result.value.kind === 'no-org') return c.json({ error: 'Create your group first.' }, 409);
    return c.json({ id: result.value.id, name, year }, 201);
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
