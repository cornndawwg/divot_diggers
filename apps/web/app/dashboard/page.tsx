'use client';

import { useCallback, useEffect, useState } from 'react';
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

interface Organization {
  id: string;
  name: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out'>('loading');

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/api/me`, { credentials: 'include' });
    if (response.status === 401) {
      setState('signed-out');
      return;
    }
    setMe((await response.json()) as Me);
    const groups = await fetch(`${apiUrl}/api/organizations`, { credentials: 'include' });
    setOrgs(((await groups.json()) as { organizations: Organization[] }).organizations);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createGroup() {
    if (groupName.trim() === '') return;
    setBusy(true);
    await fetch(`${apiUrl}/api/organizations`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: groupName.trim() }),
    });
    setBusy(false);
    setGroupName('');
    await load();
  }

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
          <dt>Group</dt>
          <dd>
            {orgs.length > 0 ? (
              orgs.map((org) => <div key={org.id}>{org.name}</div>)
            ) : (
              <>
                {/* Without a group, row level security hides every course and event. */}
                <p className="hint">
                  You are not in a group yet. Create one and the rest of the app opens up.
                </p>
                <div className="row" style={{ marginTop: '0.5rem' }}>
                  <input
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                    placeholder="Divot Diggers"
                    aria-label="Group name"
                  />
                  <button type="button" onClick={() => void createGroup()} disabled={busy}>
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </>
            )}
          </dd>
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
          <a href="/courses">Courses</a>
        </p>
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
