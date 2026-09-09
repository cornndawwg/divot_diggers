'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiUrl } from '../../lib/auth-client';

/**
 * Where an invitation link lands.
 *
 * The person clicking it may have no account, so the token is held while they sign up and
 * spent the moment they come back signed in. Losing it between those two steps would strand
 * somebody holding a perfectly good invitation with no way to use it, so it goes into
 * sessionStorage as well as staying in the URL.
 */
const HELD_TOKEN = 'ddga.invitation';

function JoinInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<'working' | 'joined' | 'signed-out' | 'problem'>('working');
  const [message, setMessage] = useState('');
  const [group, setGroup] = useState<string | null>(null);

  const token = params.get('token') ?? '';

  const accept = useCallback(async () => {
    const held = (() => {
      try {
        return token !== '' ? token : (sessionStorage.getItem(HELD_TOKEN) ?? '');
      } catch {
        return token;
      }
    })();

    if (held === '') {
      setState('problem');
      setMessage('That link is missing its invitation code. Ask for a new one.');
      return;
    }
    try {
      sessionStorage.setItem(HELD_TOKEN, held);
    } catch {
      // A browser refusing storage is fine; the URL still has it.
    }

    const response = await fetch(`${apiUrl}/api/invitations/accept`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: held }),
    });

    if (response.status === 401) {
      setState('signed-out');
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!response.ok) {
      setState('problem');
      setMessage(body.error ?? 'That invitation could not be accepted.');
      return;
    }
    try {
      sessionStorage.removeItem(HELD_TOKEN);
    } catch {
      // Nothing to clean up.
    }
    setGroup(body.name ?? null);
    setState('joined');
  }, [token]);

  useEffect(() => {
    void accept();
  }, [accept]);

  if (state === 'working') return <div className="card">Checking your invitation…</div>;

  if (state === 'signed-out') {
    return (
      <>
        <h1>You are invited</h1>
        <div className="card">
          <p>
            Sign in, or create an account, and you will join the group straight away. Your
            invitation is held until you come back.
          </p>
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button type="button" onClick={() => router.push('/sign-up')}>
              Create an account
            </button>
            <button type="button" className="ghost" onClick={() => router.push('/sign-in')}>
              I already have one
            </button>
          </div>
        </div>
      </>
    );
  }

  if (state === 'problem') {
    return (
      <>
        <h1>That invitation did not work</h1>
        <div className="card">
          <p className="check fail">{message}</p>
          <p className="note">
            Whoever invited you can send another from their Group page.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>You are in</h1>
      <div className="card">
        <p className="ok">
          You have joined {group ?? 'the group'}.
        </p>
        <p className="note">
          <Link href="/group">See who else is here</Link>
          {' · '}
          <Link href="/roster">Roster</Link>
          {' · '}
          <Link href="/standings">Standings</Link>
        </p>
      </div>
    </>
  );
}

export default function JoinPage() {
  // useSearchParams needs a suspense boundary for a statically rendered route.
  return (
    <Suspense fallback={<div className="card">Loading…</div>}>
      <JoinInner />
    </Suspense>
  );
}
