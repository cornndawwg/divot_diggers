'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiUrl, authClient } from '../../lib/auth-client';

interface EventRole {
  eventId: string;
  eventName: string;
  roles: string[];
}

interface Me {
  id: string;
  displayName: string;
  email: string | null;
  events: EventRole[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${apiUrl}/api/me`, { credentials: 'include' });
      if (cancelled) return;
      if (response.status === 401) {
        setState('signed-out');
        return;
      }
      setMe((await response.json()) as Me);
      setState('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    return <div className="card">Loading…</div>;
  }

  if (state === 'signed-out' || me === null) {
    return (
      <>
        <h1>Signed out</h1>
        <div className="card">
          <p className="note">
            <a href="/sign-in">Sign in</a>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>{me.displayName}</h1>
      <p className="sub">You are signed in.</p>
      <div className="card">
        <dl>
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Events</dt>
          <dd>
            {me.events.length === 0
              ? 'None yet — a planner will add you to an event roster.'
              : me.events.map((event) => (
                  <div key={event.eventId}>
                    {event.eventName} — {event.roles.join(', ')}
                  </div>
                ))}
          </dd>
        </dl>
        <p className="note">
          <button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              router.push('/sign-in');
            }}
          >
            Sign out
          </button>
        </p>
      </div>
    </>
  );
}
