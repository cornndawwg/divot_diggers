import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Talking to the server from a phone.
 *
 * Everything goes to the console's public origin, which proxies `/api/*` through to the API
 * server-side. The API itself has no public domain on purpose, and this keeps it that way:
 * one origin, one certificate, nothing new to expose.
 *
 * Authentication is a bearer token rather than a cookie. React Native has no cookie jar worth
 * relying on, and the session has to survive the app being killed and the phone rebooted, so
 * the token lives in the device keychain and is sent on every request.
 */
const TOKEN_KEY = 'ddga.session-token';

/**
 * React Native sends `Origin: null`, which the server refuses — a null origin is what a
 * sandboxed page sends, and trusting it would weaken the same check for browsers. So say who
 * we actually are. This matches `expo.scheme` in app.json and MOBILE_SCHEME on the server.
 */
const ORIGIN = 'divotdiggers://';

function baseUrl(): string {
  const configured = Constants.expoConfig?.extra?.['apiUrl'];
  if (typeof configured === 'string' && configured !== '') return configured.replace(/\/$/, '');
  throw new Error('No apiUrl in app.json — the app does not know which server to talk to.');
}

let cached: string | null = null;

export async function storedToken(): Promise<string | null> {
  if (cached !== null) return cached;
  cached = await SecureStore.getItemAsync(TOKEN_KEY);
  return cached;
}

async function rememberToken(token: string): Promise<void> {
  cached = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function forgetToken(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await storedToken();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('origin', ORIGIN);
  if (token !== null) headers.set('authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  } catch {
    // A phone on a golf course loses signal constantly. Say so plainly rather than
    // surfacing whatever the platform calls it this week.
    throw new ApiError(0, 'No connection. This will retry when you have signal again.');
  }

  // Sign-in hands the token back in a header; keep it before anything else can fail.
  const issued = response.headers.get('set-auth-token');
  if (issued !== null && issued !== '') await rememberToken(issued);

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof (body as { error?: unknown })?.error === 'string'
        ? (body as { error: string }).error
        : typeof (body as { message?: unknown })?.message === 'string'
          ? (body as { message: string }).message
          : 'Something went wrong.';
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export interface Me {
  id: string;
  displayName: string;
  email: string | null;
  events: { eventId: string; eventName: string; orgId: string; roles: string[] }[];
}

export const api = {
  async signIn(email: string, password: string): Promise<void> {
    await request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if ((await storedToken()) === null) {
      // Better Auth answers 200 with no token when the address is unverified.
      throw new ApiError(403, 'Confirm your email address first, then sign in.');
    }
  },

  async signOut(): Promise<void> {
    await request('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    await forgetToken();
  },

  me(): Promise<Me> {
    return request<Me>('/api/me');
  },

  join(code: string): Promise<{ eventId: string; name: string; year: number; group: string }> {
    return request('/api/join', { method: 'POST', body: JSON.stringify({ code }) });
  },
};
