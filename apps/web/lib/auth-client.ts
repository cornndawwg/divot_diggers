'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * The console talks to the API over HTTP and never to the database. Cookies carry the
 * session, so every request needs credentials included.
 */
export const authClient = createAuthClient({
  baseURL: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787'}/api/auth`,
  fetchOptions: { credentials: 'include' },
});

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
