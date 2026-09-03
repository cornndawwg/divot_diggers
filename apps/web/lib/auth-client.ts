'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The console talks to the API over its own origin, which Next proxies through to the API
 * server side. Same-origin means first-party session cookies, no CORS, and one port to
 * forward when developing on a remote machine.
 */

/**
 * Better Auth's client builds a `URL` from its base, so it needs an absolute origin rather
 * than a path — and this module is evaluated during server rendering too, where there is no
 * `window`. Resolve it per environment instead of hard-coding either case.
 */
function origin(): string {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
}

export const authClient = createAuthClient({
  baseURL: `${origin()}/api/auth`,
  fetchOptions: { credentials: 'include' },
});

/**
 * Empty, so `fetch` calls are same-origin paths like `/api/courses`. Relative paths are fine
 * for fetch; only Better Auth needs the absolute form above.
 */
export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
