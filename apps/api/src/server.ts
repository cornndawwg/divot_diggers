// Starts the API.
//
//   pnpm dev:api
//
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from './app.ts';
import { createAuth } from './auth/auth.ts';
import { loadEnv } from './env.ts';
import { createMailgunMailer } from './mail/mailer.ts';

const env = loadEnv();

// Two pools, deliberately. See the note in auth.ts and docs/schema.sql's footguns.
const privilegedPool = new Pool({ connectionString: env.databaseUrl });
const domainPool = new Pool({
  connectionString: process.env['APP_DATABASE_URL'] ?? env.databaseUrl,
});

const mailer = createMailgunMailer({
  apiKey: env.mailgunApiKey,
  domain: env.mailgunDomain,
  from: env.mailFrom,
});

const auth = createAuth({
  pool: privilegedPool,
  secret: env.authSecret,
  baseUrl: env.publicUrl,
  webUrl: env.webUrl,
  mailer,
  extraTrustedOrigins: env.extraTrustedOrigins,
});

const app = createApp({ auth, privilegedPool, domainPool, webUrl: env.webUrl, mailer });

/**
 * Ask the database whether the domain connection can bypass row level security.
 *
 * Checking that APP_DATABASE_URL is merely *set* is not enough, and assuming otherwise was a
 * mistake: pointing it at the same credentials as DATABASE_URL satisfies that check and
 * leaves every policy in the schema inert, because a Postgres table owner bypasses its own
 * RLS. So ask Postgres directly, as the role that will actually run the queries.
 *
 * Any one of these three is enough to switch tenancy off entirely, with no error anywhere
 * and no visible symptom until one group sees another's data.
 */
async function rlsBypassReasons(): Promise<string[]> {
  const { rows } = await domainPool.query<{
    role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owned: string;
  }>(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid)::text
              AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (row === undefined) return ['the database did not report who it is connected as'];

  const reasons: string[] = [];
  if (row.rolsuper) reasons.push(`"${row.role}" is a superuser`);
  if (row.rolbypassrls) reasons.push(`"${row.role}" has the BYPASSRLS attribute`);
  if (row.owned !== '0') reasons.push(`"${row.role}" owns ${row.owned} of the tables`);
  return reasons;
}

const bypass = await rlsBypassReasons();
if (bypass.length > 0) {
  const message =
    `Domain queries would bypass row level security: ${bypass.join(', ')}.\n\n` +
    'Every tenancy policy in the schema would be inert, and one group could read\n' +
    "another's data with nothing in the logs to say so.\n\n" +
    'Create a separate non-owning role and point APP_DATABASE_URL at it:\n\n' +
    '  APP_DATABASE_URL=postgresql://ddga_app:<password>@<host>:<port>/<database>\n' +
    '  pnpm db:provision-role\n';

  if (process.env['NODE_ENV'] === 'production') {
    console.error(`\n${message}`);
    process.exit(1);
  }
  console.warn(`\n  WARNING: ${message}`);
}

const port = Number(process.env['PORT'] ?? 8787);

// Fail with something actionable rather than a stack trace from the first query.
try {
  const { rows } = await privilegedPool.query<{ ready: boolean }>(
    `SELECT to_regclass('public.people') IS NOT NULL
        AND to_regclass('public.\"user\"') IS NOT NULL AS ready`,
  );
  if (rows[0]?.ready !== true) {
    console.error(
      'The database has no schema yet. Run this first:\n\n  pnpm db:setup-dev\n',
    );
    process.exit(1);
  }
} catch (error) {
  console.error(
    `Could not reach the database.\n\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
      'Is the container running? Try:  docker start ddga-postgres\n',
  );
  process.exit(1);
}

process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use, so the API did not start.\n\n` +
        'Something is already listening there — most likely another copy of this server.\n' +
        `Find it with:   ss -ltnp | grep ':${port} '\n` +
        `Stop it with:   kill $(lsof -t -i :${port} 2>/dev/null || echo '<pid from above>')\n` +
        `Or use another port:  PORT=8788 pnpm dev:api\n`,
    );
    process.exit(1);
  }
  throw error;
});

/**
 * Bind on every interface, IPv6 included.
 *
 * The default is 0.0.0.0, which is IPv4 only. Railway's private network resolves
 * <service>.railway.internal to an IPv6 address, so an API bound to 0.0.0.0 is simply
 * unreachable from the console service and every proxied request fails to connect.
 */
const hostname = process.env['HOST'] ?? '::';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  console.log(`  auth routes  ${env.publicUrl}/api/auth/*`);
  console.log(`  console      ${env.webUrl}`);
  if (process.env['APP_DATABASE_URL'] === undefined) {
    console.warn(
      '\n  WARNING: APP_DATABASE_URL is not set, so domain queries run as the database owner.\n' +
        '  A table owner bypasses its own RLS policies, which would make every policy\n' +
        '  decorative. Run `pnpm db:setup-dev` to create a non-owning role.\n',
    );
  }
});
