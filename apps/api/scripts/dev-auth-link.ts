// Prints an auth link in the terminal instead of emailing it.
//
// Verification and reset links point at API_URL, which is localhost during development.
// An email client on another device cannot open that, which makes the flow untestable
// before there is a public URL. This asks Better Auth for a real link — the same code
// path the email uses — and prints it so it can be pasted into a browser that does have
// the ports forwarded.
//
//   pnpm auth:link verify <email>
//   pnpm auth:link reset  <email>
//
// Development only. It never sends email.
import { Pool } from 'pg';
import { createAuth } from '../src/auth/auth.ts';
import { loadEnv } from '../src/env.ts';
import { createCapturingMailer } from '../src/mail/mailer.ts';

const [kind, email] = process.argv.slice(2);

if (kind !== 'verify' && kind !== 'reset') {
  console.error('Usage:\n  pnpm auth:link verify <email>\n  pnpm auth:link reset <email>');
  process.exit(1);
}
if (email === undefined || !email.includes('@')) {
  console.error(`Give an email address. Received: ${String(email)}`);
  process.exit(1);
}

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const mailer = createCapturingMailer();
const auth = createAuth({
  pool,
  secret: env.authSecret,
  baseUrl: env.publicUrl,
  webUrl: env.webUrl,
  mailer,
});

try {
  const exists = await pool.query<{ emailVerified: boolean }>(
    'SELECT "emailVerified" FROM "user" WHERE email = $1',
    [email],
  );
  if (exists.rows.length === 0) {
    console.error(`No account exists for ${email}. Sign up in the console first.`);
    process.exit(1);
  }

  if (kind === 'verify') {
    if (exists.rows[0]?.emailVerified === true) {
      console.log(`${email} is already verified. Nothing to do.`);
      process.exit(0);
    }
    await auth.api.sendVerificationEmail({ body: { email } });
  } else {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${env.webUrl}/reset-password` },
    });
  }

  const captured = mailer.lastTo(email);
  const link = captured?.text.match(/https?:\/\/\S+/)?.[0];
  if (link === undefined) {
    console.error('Better Auth produced no link. Is the account in the expected state?');
    process.exit(1);
  }

  console.log();
  console.log(kind === 'verify' ? 'Email verification link:' : 'Password reset link:');
  console.log();
  console.log(`  ${link}`);
  console.log();
  console.log('Paste it into a browser with ports 8787 and 3000 forwarded.');
  console.log('No email was sent.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await pool.end();
}
