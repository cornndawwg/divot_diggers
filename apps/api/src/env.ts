/**
 * Environment loading with errors a human can act on.
 *
 * Nothing here has a default that would let the app start half-configured: a missing
 * mail key should stop the server, not silently drop verification emails.
 */
export interface ApiEnv {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly baseUrl: string;
  readonly webUrl: string;
  readonly mailgunApiKey: string;
  readonly mailgunDomain: string;
  readonly mailFrom: string;
}

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function loadEnv(): ApiEnv {
  const mailgunDomain = required('MAILGUN_DOMAIN', 'The Mailgun sending domain, e.g. example.com.');
  return {
    databaseUrl: required('DATABASE_URL', 'The Postgres connection string, from .env.'),
    authSecret: required(
      'AUTH_SECRET',
      'A random string used to sign sessions. Generate one with: openssl rand -hex 32',
    ),
    baseUrl: optional('API_URL', 'http://localhost:8787'),
    webUrl: optional('WEB_URL', 'http://localhost:3000'),
    mailgunApiKey: required('MAILGUN_API', 'The Mailgun private API key, from .env.'),
    mailgunDomain,
    mailFrom: optional('MAIL_FROM', `Divot Diggers <noreply@${mailgunDomain}>`),
  };
}
