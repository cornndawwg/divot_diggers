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
});

const app = createApp({ auth, privilegedPool, domainPool, webUrl: env.webUrl });

/**
 * In production, connecting domain queries as the owner is not a warning, it is a breach.
 *
 * A Postgres table owner bypasses its own row level security, so an API without a separate
 * non-owning role has every tenancy policy in the schema switched off — org A can read org
 * B, and nothing in the logs, the tests or the console says a word. On a developer's machine
 * that is a nuisance worth a warning. On a deployed server it is the whole of invariant #5,
 * so refuse to start instead.
 */
if (process.env['NODE_ENV'] === 'production' && process.env['APP_DATABASE_URL'] === undefined) {
  console.error(
    '\nAPP_DATABASE_URL is not set.\n\n' +
      'Domain queries would run as the database owner, which bypasses every row level\n' +
      'security policy and lets one group read another\'s data. Create the non-owning role\n' +
      'with `pnpm db:provision-role`, then set APP_DATABASE_URL to its connection string.\n',
  );
  process.exit(1);
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
