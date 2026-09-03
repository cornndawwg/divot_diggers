import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import type { Mailer } from '../mail/mailer.ts';
import { passwordResetEmail, verificationEmail } from '../mail/templates.ts';

export interface AuthOptions {
  /**
   * A PRIVILEGED pool. Better Auth writes sessions and verification tokens before any
   * person is identified, and account creation cannot satisfy an RLS policy keyed on
   * current_person_id() because the person does not exist yet — see migration 0003.
   * Domain queries use a separate, non-owning pool.
   */
  readonly pool: Pool;
  readonly secret: string;
  readonly baseUrl: string;
  readonly webUrl: string;
  readonly mailer: Mailer;
}

export function createAuth(options: AuthOptions) {
  const { pool, secret, baseUrl, webUrl, mailer } = options;

  return betterAuth({
    database: pool,
    secret,
    baseURL: baseUrl,
    basePath: '/api/auth',
    trustedOrigins: [webUrl],

    emailAndPassword: {
      enabled: true,
      // A verified address is the only way to reach a player with a reset link, so an
      // unverified account cannot sign in.
      requireEmailVerification: true,
      minPasswordLength: 10,
      async sendResetPassword({ user, url }) {
        await mailer.send(passwordResetEmail(user.email, url));
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      /**
       * Link the credential to a golfer only once the address is verified.
       *
       * A planner can add someone to the archive before that person has an account, so a
       * `people` row with their email may already exist carrying a rating history. Claiming
       * it at sign-up would hand that history to anyone who typed a known address; claiming
       * it here happens only after control of the address is proven.
       */
      async afterEmailVerification(user) {
        await pool.query('SELECT claim_person_for_auth_user($1, $2, $3)', [
          user.id,
          user.email,
          user.name === '' ? user.email : user.name,
        ]);
      },
      async sendVerificationEmail({ user, token }) {
        // Build the link rather than using the supplied `url`, whose callbackURL defaults
        // to "/" — that would land the golfer on the API, which serves no pages. Send them
        // to the console's confirmation page instead.
        const target = new URL(`${baseUrl}/api/auth/verify-email`);
        target.searchParams.set('token', token);
        target.searchParams.set('callbackURL', `${webUrl}/verified`);
        await mailer.send(verificationEmail(user.email, target.toString()));
      },
    },

    user: {
      // Better Auth owns the credential; `people` owns the golfer. They are linked by
      // people.auth_user_id, created by the hook below.
      additionalFields: {},
    },

    databaseHooks: {},

    advanced: {
      // Cross-origin during development: the console runs on :3000, the API on :8787.
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: baseUrl.startsWith('https://'),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
