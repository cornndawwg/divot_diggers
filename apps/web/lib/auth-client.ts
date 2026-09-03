'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The console talks to the API over its own origin, which Next proxies through to the API
 * server side. Same-origin means first-party session cookies, no CORS, and one port to
 * forward when developing on a remote machine.
 */
export const authClient = createAuthClient({
  baseURL: '/api/auth',
  fetchOptions: { credentials: 'include' },
});

/** Empty, so every call is a same-origin path like `/api/courses`. */
export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
