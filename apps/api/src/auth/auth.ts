import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import type { Pool } from 'pg';
import type { Mailer } from '../mail/mailer.ts';
import { passwordResetEmail, verificationEmail } from '../mail/templates.ts';

/** Matches `expo.scheme` in apps/mobile/app.json. The app sends it as its Origin. */
export const MOBILE_SCHEME = 'divotdiggers';

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
    /**
     * The console's origin, and the phone app's URL scheme.
     *
     * The origin check is CSRF protection: it stops a page on someone else's site making a
     * request that rides on a browser's cookies. React Native sends `Origin: null`, which
     * Better Auth refuses — correctly, because a null origin is what a sandboxed iframe or a
     * file:// page sends, and trusting it would undo the protection for browsers too.
     *
     * So the app announces itself as `divotdiggers://` and that scheme is trusted here. This
     * costs a browser nothing: a browser cannot set Origin to a custom scheme, so the check
     * that matters is unchanged. Any other origin is still refused, `null` included.
     */
    trustedOrigins: [webUrl, `${MOBILE_SCHEME}://`],

    /**
     * Let a client authenticate with `Authorization: Bearer <token>` as well as a cookie.
     *
     * The console is a browser and uses cookies. A phone is not: React Native has no cookie
     * jar worth relying on, and the session has to survive the app being killed and the phone
     * being rebooted. The bearer plugin ships inside better-auth, so this costs no new
     * dependency, and it changes nothing for the console — a cookie still works exactly as
     * before, and a request carrying neither is still unauthenticated.
     */
    plugins: [bearer()],

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
      /**
       * Keep the origin check on under test.
       *
       * Better Auth switches it off by itself when it detects a test environment, which
       * means every assertion about origins passes whether the code is right or wrong. That
       * is how a sign-in screen shipped that no phone could use: the suite was structurally
       * incapable of noticing. Saying so explicitly overrides the detection, so the tests
       * exercise the same rules production does.
       */
      disableOriginCheck: false,

      // Cross-origin during development: the console runs on :3000, the API on :8787.
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: baseUrl.startsWith('https://'),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
