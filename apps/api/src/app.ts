import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Pool } from 'pg';
import type { Auth } from './auth/auth.ts';
import { plannerRoutes } from './planner/routes.ts';

export interface AppOptions {
  readonly auth: Auth;
  /**
   * Privileged. Used ONLY to resolve which golfer a validated session belongs to.
   *
   * That lookup cannot go through the RLS-bound pool: since migration 0003, reading a
   * `people` row requires `app.person_id` to be set, and the whole point of the lookup is
   * to discover what to set it to. Identity resolution is part of authentication, so it
   * sits on the privileged side of the line and nothing else does.
   */
  readonly privilegedPool: Pool;
  /**
   * The NON-OWNING pool. Every read of actual domain data goes through this so RLS is in
   * force.
   */
  readonly domainPool: Pool;
  readonly webUrl: string;
}

export interface PersonSummary {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  /** Roles are per event, and one person can hold several in the same event. */
  readonly events: readonly {
    readonly eventId: string;
    readonly eventName: string;
    readonly orgId: string;
    readonly roles: readonly string[];
  }[];
}

export function createApp(options: AppOptions): Hono {
  const { auth, privilegedPool, domainPool, webUrl } = options;
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: webUrl,
      credentials: true,
      allowHeaders: ['Content-Type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  // Better Auth owns every route under here: sign-up, sign-in, verification, reset.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  app.route('/', plannerRoutes({ auth, privilegedPool, domainPool }));

  app.get('/api/me', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session === null) {
      return c.json({ error: 'Not signed in.' }, 401);
    }

    // Resolve the golfer behind the credential. Privileged, and deliberately the only
    // thing that is — see the note on AppOptions.
    const person = await privilegedPool.query<{
      id: string;
      display_name: string;
      email: string | null;
    }>('SELECT id, display_name, email FROM people WHERE auth_user_id = $1', [session.user.id]);
    const found = person.rows[0];
    if (found === undefined) {
      return c.json({ error: 'No golfer profile is linked to this account.' }, 404);
    }

    // Everything from here reads as that person, under RLS.
    const client = await domainPool.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.person_id', found.id]);

      const roles = await client.query<{
        event_id: string;
        event_name: string;
        org_id: string;
        role: string;
      }>(
        `SELECT r.event_id, e.name AS event_name, e.org_id, r.role
           FROM event_roles r
           JOIN events e ON e.id = r.event_id
          WHERE r.person_id = $1
          ORDER BY e.year DESC, e.name, r.role`,
        [found.id],
      );

      const byEvent = new Map<string, { eventId: string; eventName: string; orgId: string; roles: string[] }>();
      for (const row of roles.rows) {
        const entry = byEvent.get(row.event_id) ?? {
          eventId: row.event_id,
          eventName: row.event_name,
          orgId: row.org_id,
          roles: [],
        };
        entry.roles.push(row.role);
        byEvent.set(row.event_id, entry);
      }

      const summary: PersonSummary = {
        id: found.id,
        displayName: found.display_name,
        email: found.email,
        events: [...byEvent.values()],
      };
      return c.json(summary);
    } finally {
      await client.query('SELECT set_config($1, $2, false)', ['app.person_id', '']);
      client.release();
    }
  });

  return app;
}
