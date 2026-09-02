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
  baseUrl: env.baseUrl,
  webUrl: env.webUrl,
  mailer,
});

const app = createApp({ auth, privilegedPool, domainPool, webUrl: env.webUrl });

const port = Number(process.env['PORT'] ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  console.log(`  auth routes  ${env.baseUrl}/api/auth/*`);
  console.log(`  console      ${env.webUrl}`);
  if (process.env['APP_DATABASE_URL'] === undefined) {
    console.warn(
      '\n  WARNING: APP_DATABASE_URL is not set, so domain queries run as the database owner.\n' +
        '  A table owner bypasses its own RLS policies. Set APP_DATABASE_URL to a\n' +
        '  non-owning role before this is exposed to anyone but you.\n',
    );
  }
});
