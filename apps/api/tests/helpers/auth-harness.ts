import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.ts';
import { createAuth, type Auth } from '../../src/auth/auth.ts';
import { createCapturingMailer, type CapturingMailer } from '../../src/mail/mailer.ts';

const REPO_ROOT = new URL('../../../../', import.meta.url);
const MIGRATIONS_DIR = fileURLToPath(new URL('packages/db/migrations', REPO_ROOT));

function baseUrl(): URL {
  const envPath = fileURLToPath(new URL('.env', REPO_ROOT));
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (line === undefined) throw new Error('DATABASE_URL missing from .env');
  return new URL(line.slice('DATABASE_URL='.length).trim());
}

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = baseUrl();
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export interface AuthHarness {
  readonly app: Hono;
  readonly auth: Auth;
  readonly mailer: CapturingMailer;
  /** Owns the tables. Used to seed and to inspect. */
  readonly privilegedPool: Pool;
  /** Non-owning, RLS-bound, exactly as the API's domain queries run. */
  readonly domainPool: Pool;
  readonly domainRole: string;
  /** Call the API the way a browser would. */
  request(path: string, init?: RequestInit & { cookies?: string }): Promise<Response>;
  destroy(): Promise<void>;
}

const API_URL = 'http://localhost:8787';
const WEB_URL = 'http://localhost:3000';

export async function createAuthHarness(name: string): Promise<AuthHarness> {
  const role = `${name}_app`;
  const password = randomUUID();

  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } finally {
    await admin.end();
  }

  const privilegedPool = new Pool({ connectionString: urlFor(name) });
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await privilegedPool.query(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
  }

  // Deliberately over-granted: SELECT on ALL tables, exactly as docs/schema.sql documents.
  // The auth tables must still be unreadable, and that is RLS's job, not the grant's.
  await privilegedPool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await privilegedPool.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await privilegedPool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

  const domainPool = new Pool({ connectionString: urlFor(name, { name: role, password }) });
  const mailer = createCapturingMailer();

  const auth = createAuth({
    pool: privilegedPool,
    secret: randomUUID() + randomUUID(),
    baseUrl: API_URL,
    webUrl: WEB_URL,
    mailer,
  });

  const app = createApp({ auth, privilegedPool, domainPool, webUrl: WEB_URL });

  return {
    app,
    auth,
    mailer,
    privilegedPool,
    domainPool,
    domainRole: role,
    async request(path, init = {}) {
      const { cookies, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookies !== undefined) headers.set('cookie', cookies);
      if (rest.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return app.fetch(new Request(`${API_URL}${path}`, { ...rest, headers }));
    },
    async destroy() {
      await domainPool.end();
      await privilegedPool.end();
      const cleanup = new Pool({ connectionString: urlFor('postgres') });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Pull the one URL out of a captured email. */
export function linkFrom(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  if (match === null) throw new Error(`no link found in email body:\n${text}`);
  return match[0];
}

/** Collect Set-Cookie headers into a Cookie header. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
